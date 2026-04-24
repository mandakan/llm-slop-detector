import { BUILTIN_PACKS, loadRules } from '../../src/core/rules';
import { scanText, Language } from '../../src/core/scan';
import { Finding, RuleSet, Severity } from '../../src/core/types';
import { BUILTIN_RAW, PACK_RAWS } from './rules.generated';
import { Prefs, getPrefs, onPrefsChanged, isHostDisabled } from './storage';

// Skip frames we can't control (iframes) and the extension's own popover.
// The popover lives inside an element with class lsd-host; skip anything
// that lives inside one.
const HOST_CLASS = 'lsd-host';
const BADGE_CLASS = 'lsd-badge';
const POPOVER_CLASS = 'lsd-popover';
const MIRROR_CLASS = 'lsd-mirror';
const STYLE_ID = 'lsd-style';

// Computed-style properties to mirror from textarea to overlay so the overlay
// lays out characters at the same positions. Size (width/height) is set
// separately from getBoundingClientRect(). box-sizing is deliberately not
// copied -- we force border-box on the mirror (see HOST_CLASS rule) and size
// it from the editor's outer rect, so the mirror's content area matches the
// textarea's regardless of whether the host page uses content-box or
// border-box on the editor.
const MIRROR_COPY_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'font-stretch', 'line-height', 'letter-spacing', 'word-spacing', 'tab-size',
  'text-indent', 'text-transform', 'writing-mode', 'direction',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
] as const;

const HOST = location.host.toLowerCase();
const DEBOUNCE_MS = 150;
const SIZE_CAP = 200 * 1024;
const MIN_EDITOR_CHARS = 40; // skip search boxes

// markdown mode is the right default for most web textareas: GitHub issues,
// Substack, Reddit, Obsidian Publish, Notion drafts all accept markdown, and
// the mode only subtracts false positives (fenced code, link URLs, inline
// code) rather than adding them.
const LANGUAGE: Language = 'markdown';

type EditorKind = 'textarea' | 'input';
type EditorState = {
  editor: HTMLTextAreaElement | HTMLInputElement;
  kind: EditorKind;
  badge: HTMLElement;
  mirror: HTMLElement | null;
  debounceHandle: number | null;
  lastFindings: Finding[];
  lastText: string;
  resizeObserver: ResizeObserver | null;
};

const editors = new WeakMap<Element, EditorState>();
// Separate iterable registry so reflowAll() can walk every live editor.
// We prune entries when their editor leaves the DOM inside positionOverlays.
const editorRegistry = new Set<HTMLTextAreaElement | HTMLInputElement>();
let rules: RuleSet;
let prefs: Prefs;
let popover: HTMLElement | null = null;
let activeEditorEl: (HTMLTextAreaElement | HTMLInputElement) | null = null;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  prefs = await getPrefs();
  if (!prefs.enabled || isHostDisabled(prefs, HOST)) return;

  rules = buildRules(prefs.enabledPacks);
  injectStyles();
  scanDocument();
  observeMutations();

  onPrefsChanged(next => {
    const wasOn = prefs.enabled && !isHostDisabled(prefs, HOST);
    prefs = next;
    const isOn = prefs.enabled && !isHostDisabled(prefs, HOST);
    if (!isOn) {
      teardown();
      return;
    }
    if (!wasOn) {
      // Re-init from scratch -- easier than tracking which editors we had.
      rules = buildRules(prefs.enabledPacks);
      injectStyles();
      scanDocument();
      return;
    }
    // Packs changed: rebuild rules and rescan every known editor.
    rules = buildRules(prefs.enabledPacks);
    rescanAll();
  });
}

function buildRules(enabledPacks: string[]): RuleSet {
  const lists: Array<{ origin: string; raw: unknown }> = [
    { origin: 'built-in', raw: BUILTIN_RAW },
  ];
  const allowed = new Set<string>(BUILTIN_PACKS);
  for (const pack of enabledPacks) {
    if (!allowed.has(pack)) continue;
    const raw = PACK_RAWS[pack];
    if (raw) lists.push({ origin: `pack:${pack}`, raw });
  }
  return loadRules({
    lists: lists as any,
    userPhrases: [],
    charReplacements: {},
    severityOverrides: {},
  });
}

function teardown() {
  for (const ed of editorRegistry) {
    const s = editors.get(ed);
    s?.resizeObserver?.disconnect();
    editors.delete(ed);
  }
  editorRegistry.clear();
  document.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());
  document.getElementById(STYLE_ID)?.remove();
  closePopover();
}

// ---------------------------------------------------------------------------
// Editor discovery
// ---------------------------------------------------------------------------

function scanDocument() {
  document.querySelectorAll('textarea, input[type=text]').forEach(el => attach(el as HTMLElement));
}

function observeMutations() {
  const mo = new MutationObserver(mutations => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches('textarea, input[type=text]')) attach(node);
        node.querySelectorAll?.('textarea, input[type=text]').forEach(el => attach(el as HTMLElement));
      });
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

function attach(el: HTMLElement) {
  if (editors.has(el)) return;
  if (el.closest(`.${HOST_CLASS}`)) return; // don't attach to our own DOM
  if (el.hasAttribute('data-slop-ignore')) return;

  const isTextarea = el.tagName === 'TEXTAREA';
  const isText = el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text';
  if (!isTextarea && !isText) return;

  const editor = el as HTMLTextAreaElement | HTMLInputElement;

  // Heuristic: skip tiny search-like inputs. Check both maxLength and visible
  // width. Textareas rarely hit this.
  if (isText) {
    const maxLen = (editor as HTMLInputElement).maxLength;
    if (maxLen > 0 && maxLen < MIN_EDITOR_CHARS) return;
    const rect = editor.getBoundingClientRect();
    if (rect.width > 0 && rect.width < 180) return;
  }

  const badge = document.createElement('span');
  badge.className = `${HOST_CLASS} ${BADGE_CLASS} lsd-hidden`;
  badge.textContent = '0';
  badge.title = 'LLM Slop Detector';
  badge.setAttribute('role', 'button');
  badge.setAttribute('tabindex', '0');
  badge.addEventListener('click', e => { e.stopPropagation(); togglePopover(editor); });
  badge.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePopover(editor); }
  });
  document.body.appendChild(badge);

  const state: EditorState = {
    editor,
    kind: isTextarea ? 'textarea' : 'input',
    badge,
    mirror: null,
    debounceHandle: null,
    lastFindings: [],
    lastText: '',
    resizeObserver: null,
  };
  editors.set(el, state);
  editorRegistry.add(editor);

  // Inline overlay is textarea-only for now. Single-line inputs don't benefit
  // enough from inline marks (the finding list in the popover is easier to
  // read), and contenteditable support lives in its own follow-up.
  if (isTextarea) {
    state.mirror = createMirror();
    document.body.appendChild(state.mirror);
    syncMirrorStyles(state);
    editor.addEventListener('scroll', () => syncMirrorScroll(state), { passive: true });
  }

  editor.addEventListener('input', () => scheduleScan(state));
  editor.addEventListener('focus', () => positionOverlays(state));
  editor.addEventListener('blur', () => {
    // Delay so a click on the badge isn't swallowed by blur.
    setTimeout(() => { if (document.activeElement !== badge) positionOverlays(state); }, 150);
  });

  // Resizing *this* editor may also reflow *other* editors down the page.
  // Re-position everything so mirrors follow their editors, and re-sync
  // styles (size change can flip wrapping behaviour).
  if ('ResizeObserver' in window) {
    state.resizeObserver = new ResizeObserver(() => {
      syncMirrorStyles(state);
      reflowAll();
    });
    state.resizeObserver.observe(editor);
  }

  installGlobalListeners();
  positionOverlays(state);
  runScan(state);
}

let globalListenersInstalled = false;
function installGlobalListeners() {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;
  // Single handlers that iterate every live editor; cheaper than attaching N
  // per-editor window listeners and avoids missing layout shifts caused by
  // neighbouring editors resizing.
  window.addEventListener('scroll', reflowAll, { passive: true, capture: true });
  window.addEventListener('resize', () => {
    for (const ed of editorRegistry) {
      const s = editors.get(ed);
      if (s) syncMirrorStyles(s);
    }
    reflowAll();
  }, { passive: true });
  // Hover tooltip + click-to-jump via manual hit-testing. Marks themselves
  // stay pointer-transparent so textarea selection gestures aren't broken.
  document.addEventListener('mousemove', onDocMouseMove, { passive: true });
  document.addEventListener('click', onDocClick, { capture: false });
}

let tooltipEl: HTMLElement | null = null;
let tooltipOffsetKey: string | null = null;
let mousemoveRaf: number | null = null;
let lastMouseX = 0;
let lastMouseY = 0;

function onDocMouseMove(e: MouseEvent) {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  if (mousemoveRaf !== null) return;
  mousemoveRaf = requestAnimationFrame(() => {
    mousemoveRaf = null;
    processHover(lastMouseX, lastMouseY);
  });
}

function processHover(x: number, y: number) {
  const hit = findMarkAtPoint(x, y);
  if (!hit) { hideTooltip(); return; }
  const key = `${hit.mirrorKey}:${hit.offset}`;
  const msg = hit.mark.getAttribute('data-lsd-message') || '';
  showTooltip(msg, x, y, key);
}

function onDocClick(e: MouseEvent) {
  // Ignore clicks inside our own popover / badge so they don't retrigger
  // the jump when the user interacts with the popover itself.
  const target = e.target as HTMLElement | null;
  if (target?.closest(`.${HOST_CLASS}`)) return;
  const hit = findMarkAtPoint(e.clientX, e.clientY);
  if (!hit) return;
  // Native textarea click has already run (focus + caret placement). We
  // don't preventDefault; we only pop open the popover on top.
  const state = hit.state;
  if (!popover || activeEditorEl !== state.editor) openPopover(state);
  if (hit.offset >= 0) highlightPopoverFinding(hit.offset);
}

type MarkHit = { mark: HTMLElement; state: EditorState; mirrorKey: string; offset: number };

function findMarkAtPoint(x: number, y: number): MarkHit | null {
  for (const ed of editorRegistry) {
    const state = editors.get(ed);
    if (!state?.mirror) continue;
    // Quick reject: if the cursor isn't over this mirror's bbox, skip it.
    const mRect = state.mirror.getBoundingClientRect();
    if (x < mRect.left || x > mRect.right || y < mRect.top || y > mRect.bottom) continue;
    const marks = state.mirror.querySelectorAll('.lsd-mark');
    for (const markEl of marks) {
      // getClientRects returns one rect per line fragment for spans that
      // wrap, so we correctly hit-test wrapped multi-line marks.
      const rects = (markEl as HTMLElement).getClientRects();
      for (const r of rects) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const offset = parseInt((markEl as HTMLElement).getAttribute('data-lsd-offset') || '-1', 10);
          return { mark: markEl as HTMLElement, state, mirrorKey: state.mirror.id || 'm', offset };
        }
      }
    }
  }
  return null;
}

function ensureTooltip(): HTMLElement {
  if (tooltipEl && document.contains(tooltipEl)) return tooltipEl;
  const t = document.createElement('div');
  t.className = `${HOST_CLASS} lsd-tooltip`;
  t.style.display = 'none';
  document.body.appendChild(t);
  tooltipEl = t;
  return t;
}

function showTooltip(text: string, x: number, y: number, key: string) {
  const t = ensureTooltip();
  if (key !== tooltipOffsetKey) {
    t.textContent = text;
    tooltipOffsetKey = key;
  }
  t.style.display = '';
  // Position below + right of cursor, clamped to viewport.
  const pad = 12;
  const tW = t.offsetWidth;
  const tH = t.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x + pad;
  let top = y + pad;
  if (left + tW > vw - 8) left = Math.max(8, x - pad - tW);
  if (top + tH > vh - 8) top = Math.max(8, y - pad - tH);
  t.style.left = `${left + window.scrollX}px`;
  t.style.top = `${top + window.scrollY}px`;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
  tooltipOffsetKey = null;
}

function reflowAll() {
  for (const ed of editorRegistry) {
    const s = editors.get(ed);
    if (s) positionOverlays(s);
  }
}

function rescanAll() {
  document.querySelectorAll('textarea, input[type=text]').forEach(el => {
    const state = editors.get(el);
    if (state) runScan(state);
  });
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function scheduleScan(state: EditorState) {
  if (state.debounceHandle !== null) window.clearTimeout(state.debounceHandle);
  state.debounceHandle = window.setTimeout(() => {
    state.debounceHandle = null;
    runScan(state);
  }, DEBOUNCE_MS);
}

function runScan(state: EditorState) {
  const text = state.editor.value ?? '';
  state.lastText = text;
  if (text.length > SIZE_CAP) {
    state.lastFindings = [];
    updateBadge(state, -1);
    renderMirror(state);
    return;
  }
  state.lastFindings = scanText(text, rules, LANGUAGE);
  updateBadge(state, state.lastFindings.length);
  renderMirror(state);
  if (popover && activeEditorEl === state.editor) renderPopover(state);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function updateBadge(state: EditorState, count: number) {
  const { badge } = state;
  if (count === -1) {
    badge.textContent = '...';
    badge.title = 'Text too long to scan';
    badge.classList.remove('lsd-clean', 'lsd-hidden', 'lsd-dirty');
    badge.classList.add('lsd-warn');
  } else if (count === 0) {
    badge.textContent = '';
    badge.classList.add('lsd-hidden');
  } else {
    badge.textContent = String(count);
    badge.title = `${count} slop finding${count === 1 ? '' : 's'}`;
    badge.classList.remove('lsd-hidden', 'lsd-clean', 'lsd-warn');
    badge.classList.add('lsd-dirty');
  }
  positionOverlays(state);
}

function positionOverlays(state: EditorState) {
  const { editor, badge, mirror } = state;
  if (!document.contains(editor)) {
    badge.remove();
    mirror?.remove();
    state.resizeObserver?.disconnect();
    editors.delete(editor);
    editorRegistry.delete(editor);
    return;
  }
  const rect = editor.getBoundingClientRect();
  const hidden = rect.width === 0 && rect.height === 0;

  if (hidden) {
    badge.style.display = 'none';
    if (mirror) mirror.style.display = 'none';
    return;
  }
  badge.style.display = '';
  // Anchor the badge to the bottom-right of the editor, inset a bit.
  badge.style.top = `${Math.max(0, rect.bottom + window.scrollY - 22)}px`;
  badge.style.left = `${Math.max(0, rect.right + window.scrollX - 32)}px`;

  if (mirror) {
    // Match the editor's visible scrollbar gutter so the mirror's content
    // area has the same width as the textarea's, and wrapping agrees. When
    // the textarea isn't scrolling, scrollbarWidth is 0 and we fill the full
    // rect; when it is, we narrow the mirror so the scrollbar shows through.
    const cs = getComputedStyle(editor);
    const borderLeft = parseFloat(cs.getPropertyValue('border-left-width')) || 0;
    const borderRight = parseFloat(cs.getPropertyValue('border-right-width')) || 0;
    const scrollbarWidth = Math.max(0, editor.offsetWidth - editor.clientWidth - borderLeft - borderRight);
    mirror.style.display = '';
    mirror.style.top = `${rect.top + window.scrollY}px`;
    mirror.style.left = `${rect.left + window.scrollX}px`;
    mirror.style.width = `${Math.max(0, rect.width - scrollbarWidth)}px`;
    mirror.style.height = `${rect.height}px`;
    syncMirrorScroll(state);
  }
}

// ---------------------------------------------------------------------------
// Mirror overlay (inline highlights for textareas)
// ---------------------------------------------------------------------------

function createMirror(): HTMLElement {
  const m = document.createElement('div');
  m.className = `${HOST_CLASS} ${MIRROR_CLASS}`;
  // aria-hidden so screen readers ignore the duplicated text; pointer-events
  // none so the user can click/select the textarea through the overlay.
  m.setAttribute('aria-hidden', 'true');
  return m;
}

function syncMirrorStyles(state: EditorState) {
  const { editor, mirror } = state;
  if (!mirror) return;
  const cs = getComputedStyle(editor);
  for (const prop of MIRROR_COPY_PROPS) {
    mirror.style.setProperty(prop, cs.getPropertyValue(prop), 'important');
  }
  // Textareas wrap by default; respect whatever wrapping the page set.
  const wsSource = cs.getPropertyValue('white-space') || 'pre-wrap';
  const normalized = wsSource === 'normal' ? 'pre-wrap' : wsSource;
  mirror.style.setProperty('white-space', normalized, 'important');
}

function syncMirrorScroll(state: EditorState) {
  if (!state.mirror) return;
  state.mirror.scrollTop = state.editor.scrollTop;
  state.mirror.scrollLeft = state.editor.scrollLeft;
}

function renderMirror(state: EditorState) {
  if (!state.mirror) return;
  state.mirror.innerHTML = renderHighlightedHTML(state.lastText, state.lastFindings);
  // scrollHeight only becomes correct after innerHTML updates.
  syncMirrorScroll(state);
}

function renderHighlightedHTML(text: string, findings: Finding[]): string {
  // The mirror needs a trailing newline sentinel because a textarea's final
  // visual line (when text ends with \n) has height; a div's doesn't unless
  // followed by a non-empty character.
  const sentinel = text.endsWith('\n') ? ' ' : '';
  if (findings.length === 0) return escapeText(text) + sentinel;

  const sorted = [...findings].sort((a, b) => a.offset - b.offset);
  const parts: string[] = [];
  let cursor = 0;
  for (const f of sorted) {
    if (f.offset < cursor) continue; // skip overlaps
    if (f.offset > cursor) parts.push(escapeText(text.slice(cursor, f.offset)));
    parts.push(renderMarkFragments(f));
    cursor = f.offset + f.length;
  }
  if (cursor < text.length) parts.push(escapeText(text.slice(cursor)));
  return parts.join('') + sentinel;
}

// A multi-word match wrapped in a single span paints the inline background
// across the whitespace between words, including any trailing whitespace
// before a line wrap -- visually the highlight runs to the right edge of the
// line. Split at whitespace runs so each word gets its own background and
// whitespace stays unmarked.
//
// Each fragment carries the finding's offset + full message on data attrs;
// the overlay itself stays pointer-events: none so native text-selection
// gestures on the textarea are preserved. A document-level mousemove/click
// handler does hit-testing against mark rects for tooltips and click-to-jump.
function renderMarkFragments(f: Finding): string {
  const text = f.matchText;
  if (text.length === 0) return '';
  const sev = escapeAttr(f.severity);
  const off = String(f.offset);
  const msg = escapeAttr(f.message);
  const attrs = `class="lsd-mark lsd-sev-${sev}" data-lsd-offset="${off}" data-lsd-message="${msg}"`;
  const parts: string[] = [];
  const wsRe = /\s+/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = wsRe.exec(text)) !== null) {
    if (m.index > cursor) {
      parts.push(`<span ${attrs}>${escapeText(text.slice(cursor, m.index))}</span>`);
    }
    parts.push(escapeText(m[0]));
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    parts.push(`<span ${attrs}>${escapeText(text.slice(cursor))}</span>`);
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

function togglePopover(editor: HTMLTextAreaElement | HTMLInputElement) {
  if (popover && activeEditorEl === editor) {
    closePopover();
    return;
  }
  const state = editors.get(editor);
  if (!state) return;
  openPopover(state);
}

function openPopover(state: EditorState) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = `${HOST_CLASS} ${POPOVER_CLASS}`;
  pop.innerHTML = `
    <div class="lsd-pop-head">
      <span class="lsd-pop-title">LLM Slop Detector</span>
      <button class="lsd-pop-close" type="button" aria-label="Close">x</button>
    </div>
    <div class="lsd-pop-toolbar" hidden>
      <button class="lsd-fix-all" type="button">Fix all chars</button>
    </div>
    <div class="lsd-pop-body"></div>
  `;
  document.body.appendChild(pop);
  popover = pop;
  activeEditorEl = state.editor;

  pop.querySelector('.lsd-pop-close')!.addEventListener('click', closePopover);
  pop.querySelector('.lsd-fix-all')!.addEventListener('click', () => applyAllCharFixes(state));
  pop.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', onOutsideClick, { capture: true });
  document.addEventListener('keydown', onEscape);

  renderPopover(state);
  positionPopover(state);
}

function closePopover() {
  if (popover) {
    popover.remove();
    popover = null;
  }
  activeEditorEl = null;
  document.removeEventListener('click', onOutsideClick, { capture: true });
  document.removeEventListener('keydown', onEscape);
}

function onOutsideClick(e: Event) {
  const target = e.target as HTMLElement;
  if (target.closest(`.${HOST_CLASS}`)) return;
  closePopover();
}

function onEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') closePopover();
}

function positionPopover(state: EditorState) {
  if (!popover) return;
  const rect = state.editor.getBoundingClientRect();
  // Position below the editor if there's room, otherwise above.
  const spaceBelow = window.innerHeight - rect.bottom;
  const popHeight = Math.min(360, popover.offsetHeight || 360);
  const top = spaceBelow > popHeight + 12
    ? rect.bottom + window.scrollY + 6
    : Math.max(8 + window.scrollY, rect.top + window.scrollY - popHeight - 6);
  const left = Math.min(
    rect.left + window.scrollX,
    window.innerWidth + window.scrollX - 340,
  );
  popover.style.top = `${top}px`;
  popover.style.left = `${Math.max(8 + window.scrollX, left)}px`;
}

function renderPopover(state: EditorState) {
  if (!popover) return;
  const body = popover.querySelector('.lsd-pop-body') as HTMLElement;
  const toolbar = popover.querySelector('.lsd-pop-toolbar') as HTMLElement;
  const findings = state.lastFindings;

  // Show fix-all only when there's at least one char finding with a fix.
  const fixableCount = findings.reduce((n, f) => {
    if (f.code !== 'char') return n;
    const def = rules.chars.get(f.matchText);
    return def?.replacement !== undefined ? n + 1 : n;
  }, 0);
  toolbar.hidden = fixableCount === 0;
  const fixAllBtn = toolbar.querySelector('.lsd-fix-all') as HTMLButtonElement;
  fixAllBtn.textContent = fixableCount > 1 ? `Fix all ${fixableCount} chars` : 'Fix char';

  if (findings.length === 0) {
    body.innerHTML = '<div class="lsd-empty">No slop detected.</div>';
    return;
  }
  const sorted = [...findings].sort((a, b) => a.offset - b.offset);
  body.innerHTML = '';
  for (const f of sorted) {
    const item = document.createElement('div');
    item.className = `lsd-item lsd-sev-${f.severity}`;
    item.setAttribute('data-lsd-offset', String(f.offset));
    const def = f.code === 'char' ? rules.chars.get(f.matchText) : undefined;
    const hasFix = def?.replacement !== undefined;
    item.innerHTML = `
      <div class="lsd-item-head">
        <span class="lsd-badge-sev lsd-sev-${escapeAttr(f.severity)}">${escapeText(f.severity)}</span>
        <code class="lsd-match">${escapeText(f.matchText || '(empty)')}</code>
      </div>
      <div class="lsd-msg">${escapeText(f.message)}</div>
    `;
    if (hasFix) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lsd-fix';
      btn.textContent = 'Fix this';
      btn.addEventListener('click', () => applyCharFix(state, f));
      item.appendChild(btn);
    }
    body.appendChild(item);
  }
}

function highlightPopoverFinding(offset: number) {
  if (!popover) return;
  const body = popover.querySelector('.lsd-pop-body') as HTMLElement;
  const item = body.querySelector(`.lsd-item[data-lsd-offset="${offset}"]`) as HTMLElement | null;
  if (!item) return;
  item.scrollIntoView({ block: 'center' });
  // Pulse the item so the user's eye finds it. Class is removed after the
  // animation so repeated clicks on the same mark re-trigger the effect.
  item.classList.remove('lsd-pulse');
  // Force reflow so re-adding the class actually replays the animation.
  void item.offsetWidth;
  item.classList.add('lsd-pulse');
}

// ---------------------------------------------------------------------------
// Fix application
// ---------------------------------------------------------------------------

function setEditorValue(state: EditorState, next: string): void {
  // Use the native value setter so React / Vue / Lit see the change.
  const proto = state.kind === 'textarea'
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(state.editor, next);
  } else {
    state.editor.value = next;
  }
  state.editor.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyCharFix(state: EditorState, finding: Finding) {
  if (finding.code !== 'char') return;
  const def = rules.chars.get(finding.matchText);
  if (!def || def.replacement === undefined) return;
  const { editor } = state;
  const current = editor.value;
  const next = current.slice(0, finding.offset) + def.replacement + current.slice(finding.offset + finding.length);
  setEditorValue(state, next);
  editor.focus();
  const caret = finding.offset + def.replacement.length;
  try { editor.setSelectionRange(caret, caret); } catch { /* some inputs don't support */ }
  // runScan is triggered by the input event.
}

function applyAllCharFixes(state: EditorState) {
  // Apply right-to-left so earlier offsets stay valid as we mutate.
  const fixes = state.lastFindings
    .filter(f => f.code === 'char')
    .map(f => {
      const def = rules.chars.get(f.matchText);
      return def?.replacement !== undefined
        ? { offset: f.offset, length: f.length, replacement: def.replacement }
        : null;
    })
    .filter((x): x is { offset: number; length: number; replacement: string } => x !== null)
    .sort((a, b) => b.offset - a.offset);

  if (fixes.length === 0) return;

  let next = state.editor.value;
  for (const fx of fixes) {
    next = next.slice(0, fx.offset) + fx.replacement + next.slice(fx.offset + fx.length);
  }
  setEditorValue(state, next);
  state.editor.focus();
  // runScan runs via the dispatched input event.
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${HOST_CLASS} {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      color-scheme: light dark;
      box-sizing: border-box !important;
    }
    .${BADGE_CLASS} {
      position: absolute !important;
      z-index: 2147483640 !important;
      padding: 2px 6px !important;
      min-width: 20px !important;
      height: 18px !important;
      line-height: 14px !important;
      font-size: 11px !important;
      font-weight: 600 !important;
      color: #fff !important;
      background: #b08800 !important;
      border-radius: 4px !important;
      cursor: pointer !important;
      text-align: center !important;
      box-shadow: 0 1px 2px rgba(0,0,0,0.25) !important;
      user-select: none !important;
      pointer-events: auto !important;
    }
    .lsd-tooltip {
      position: absolute !important;
      z-index: 2147483642 !important;
      max-width: 320px !important;
      padding: 5px 8px !important;
      background: #1c1c1c !important;
      color: #fafaf7 !important;
      border-radius: 4px !important;
      font-size: 12px !important;
      line-height: 1.35 !important;
      pointer-events: none !important;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25) !important;
      white-space: normal !important;
      word-wrap: break-word !important;
    }
    @media (prefers-color-scheme: dark) {
      .lsd-tooltip { background: #e6e6e6 !important; color: #15171a !important; }
    }
    .${BADGE_CLASS}.lsd-hidden { display: none !important; }
    .${BADGE_CLASS}.lsd-warn { background: #d73a49 !important; }
    .${BADGE_CLASS}:hover { filter: brightness(1.1); }
    .${BADGE_CLASS}:focus-visible { outline: 2px solid #0366d6 !important; outline-offset: 1px; }

    .${MIRROR_CLASS} {
      position: absolute !important;
      z-index: 2147483639 !important;
      pointer-events: none !important;
      overflow: hidden !important;
      background: transparent !important;
      color: transparent !important;
      margin: 0 !important;
      border-style: solid !important;
      border-color: transparent !important;
      /* Match textarea wrap: whitespace-only, no word-break. Long single
         words overflow horizontally in a textarea (scrollbar); mirror just
         clips since overflow is hidden -- acceptable trade-off. */
      word-wrap: normal !important;
      overflow-wrap: normal !important;
      word-break: normal !important;
      -webkit-user-select: none !important;
      user-select: none !important;
    }
    .${MIRROR_CLASS} .lsd-mark {
      color: transparent !important;
      border-radius: 2px !important;
      box-decoration-break: clone !important;
      -webkit-box-decoration-break: clone !important;
      /* Marks stay pointer-transparent so double-click-to-select, drag
         selection, and click-to-position-caret all go to the textarea
         natively. Hover tooltips and click-to-jump are implemented via
         a document-level hit-test against mark rects. */
    }
    .${MIRROR_CLASS} .lsd-mark.lsd-sev-error       { background: rgba(215, 58, 73, 0.28) !important; }
    .${MIRROR_CLASS} .lsd-mark.lsd-sev-warning     { background: rgba(176, 136, 0, 0.28) !important; }
    .${MIRROR_CLASS} .lsd-mark.lsd-sev-information { background: rgba(3, 102, 214, 0.22) !important; }
    .${MIRROR_CLASS} .lsd-mark.lsd-sev-hint        { background: rgba(106, 115, 125, 0.22) !important; }
    @media (prefers-color-scheme: dark) {
      .${MIRROR_CLASS} .lsd-mark.lsd-sev-error       { background: rgba(255, 107, 107, 0.30) !important; }
      .${MIRROR_CLASS} .lsd-mark.lsd-sev-warning     { background: rgba(242, 193, 78, 0.30) !important; }
      .${MIRROR_CLASS} .lsd-mark.lsd-sev-information { background: rgba(88, 166, 255, 0.26) !important; }
      .${MIRROR_CLASS} .lsd-mark.lsd-sev-hint        { background: rgba(139, 148, 158, 0.26) !important; }
    }

    .${POPOVER_CLASS} {
      position: absolute !important;
      z-index: 2147483641 !important;
      width: 340px !important;
      max-height: 360px !important;
      overflow: hidden !important;
      display: flex !important;
      flex-direction: column !important;
      background: #ffffff !important;
      color: #1c1c1c !important;
      border: 1px solid #d9d9d4 !important;
      border-radius: 6px !important;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18) !important;
      font-size: 13px !important;
      line-height: 1.4 !important;
    }
    @media (prefers-color-scheme: dark) {
      .${POPOVER_CLASS} {
        background: #1c1f24 !important;
        color: #e6e6e6 !important;
        border-color: #2a2d33 !important;
      }
    }
    .${POPOVER_CLASS} .lsd-pop-head {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 6px 8px !important;
      border-bottom: 1px solid currentColor !important;
      border-bottom-color: #e5e5e0 !important;
    }
    @media (prefers-color-scheme: dark) {
      .${POPOVER_CLASS} .lsd-pop-head { border-bottom-color: #2a2d33 !important; }
    }
    .${POPOVER_CLASS} .lsd-pop-title { font-weight: 600 !important; font-size: 12px !important; }
    .${POPOVER_CLASS} .lsd-pop-close {
      all: unset !important;
      font: inherit !important;
      cursor: pointer !important;
      padding: 2px 6px !important;
      border-radius: 3px !important;
      opacity: 0.7 !important;
    }
    .${POPOVER_CLASS} .lsd-pop-close:hover { opacity: 1 !important; background: rgba(127,127,127,0.15) !important; }
    .${POPOVER_CLASS} .lsd-pop-toolbar {
      display: flex !important;
      gap: 6px !important;
      padding: 6px 8px !important;
      border-bottom: 1px solid #e5e5e0 !important;
    }
    .${POPOVER_CLASS} .lsd-pop-toolbar[hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) {
      .${POPOVER_CLASS} .lsd-pop-toolbar { border-bottom-color: #2a2d33 !important; }
    }
    .${POPOVER_CLASS} .lsd-fix-all {
      all: unset !important;
      font: inherit !important;
      font-size: 12px !important;
      padding: 3px 8px !important;
      background: rgba(3, 102, 214, 0.15) !important;
      color: #0366d6 !important;
      border-radius: 3px !important;
      cursor: pointer !important;
      font-weight: 600 !important;
    }
    .${POPOVER_CLASS} .lsd-fix-all:hover { background: rgba(3, 102, 214, 0.25) !important; }
    @media (prefers-color-scheme: dark) {
      .${POPOVER_CLASS} .lsd-fix-all { background: rgba(88, 166, 255, 0.18) !important; color: #58a6ff !important; }
      .${POPOVER_CLASS} .lsd-fix-all:hover { background: rgba(88, 166, 255, 0.3) !important; }
    }
    .${POPOVER_CLASS} .lsd-pop-body {
      overflow: auto !important;
      padding: 6px 8px !important;
      flex: 1 !important;
    }
    .${POPOVER_CLASS} .lsd-empty {
      color: #666 !important;
      padding: 8px 0 !important;
      font-style: italic !important;
    }
    .${POPOVER_CLASS} .lsd-item {
      padding: 6px 8px !important;
      margin-bottom: 6px !important;
      border-left: 3px solid #d9d9d4 !important;
      background: rgba(127,127,127,0.05) !important;
      border-radius: 3px !important;
    }
    .${POPOVER_CLASS} .lsd-item.lsd-sev-error       { border-left-color: #d73a49 !important; }
    .${POPOVER_CLASS} .lsd-item.lsd-sev-warning     { border-left-color: #b08800 !important; }
    .${POPOVER_CLASS} .lsd-item.lsd-sev-information { border-left-color: #0366d6 !important; }
    .${POPOVER_CLASS} .lsd-item.lsd-sev-hint        { border-left-color: #6a737d !important; }
    @keyframes lsd-pulse {
      0%   { box-shadow: 0 0 0 3px rgba(3, 102, 214, 0.8), 0 0 0 6px rgba(3, 102, 214, 0.2); transform: translateX(2px); }
      40%  { box-shadow: 0 0 0 3px rgba(3, 102, 214, 0.6), 0 0 0 6px rgba(3, 102, 214, 0.1); }
      100% { box-shadow: 0 0 0 0 transparent; transform: none; }
    }
    @media (prefers-color-scheme: dark) {
      @keyframes lsd-pulse {
        0%   { box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.9), 0 0 0 6px rgba(88, 166, 255, 0.25); transform: translateX(2px); }
        40%  { box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.6), 0 0 0 6px rgba(88, 166, 255, 0.15); }
        100% { box-shadow: 0 0 0 0 transparent; transform: none; }
      }
    }
    .${POPOVER_CLASS} .lsd-item.lsd-pulse {
      animation: lsd-pulse 1400ms ease-out 1 !important;
      position: relative !important;
      z-index: 1 !important;
    }

    .${POPOVER_CLASS} .lsd-item-head {
      display: flex !important;
      gap: 6px !important;
      align-items: center !important;
      flex-wrap: wrap !important;
      margin-bottom: 4px !important;
    }
    .${POPOVER_CLASS} .lsd-badge-sev {
      font-size: 10px !important;
      text-transform: uppercase !important;
      padding: 1px 5px !important;
      border-radius: 3px !important;
      color: #fff !important;
      letter-spacing: 0.03em !important;
    }
    .lsd-badge-sev.lsd-sev-error       { background: #d73a49 !important; }
    .lsd-badge-sev.lsd-sev-warning     { background: #b08800 !important; }
    .lsd-badge-sev.lsd-sev-information { background: #0366d6 !important; }
    .lsd-badge-sev.lsd-sev-hint        { background: #6a737d !important; }
    .${POPOVER_CLASS} .lsd-match {
      font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      padding: 1px 4px !important;
      background: rgba(127,127,127,0.15) !important;
      border-radius: 2px !important;
    }
    .${POPOVER_CLASS} .lsd-msg { font-size: 12px !important; color: inherit !important; opacity: 0.8 !important; }
    .${POPOVER_CLASS} .lsd-fix {
      all: unset !important;
      margin-top: 4px !important;
      font: inherit !important;
      font-size: 11px !important;
      padding: 2px 6px !important;
      background: rgba(127,127,127,0.15) !important;
      border-radius: 3px !important;
      cursor: pointer !important;
      display: inline-block !important;
    }
    .${POPOVER_CLASS} .lsd-fix:hover { background: rgba(127,127,127,0.3) !important; }
  `;
  document.documentElement.appendChild(style);
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeText(s);
}

// Kick things off. document_idle in the manifest means the DOM is parsed;
// still check in case a host page defers content.
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  main();
} else {
  document.addEventListener('DOMContentLoaded', main);
}

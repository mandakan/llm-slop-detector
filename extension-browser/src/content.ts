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

type EditorKind = 'textarea' | 'input' | 'contenteditable';
type TextControl = HTMLTextAreaElement | HTMLInputElement;
type EditorEl = TextControl | HTMLElement;
type EditorState = {
  editor: EditorEl;
  kind: EditorKind;
  badge: HTMLElement;
  mirror: HTMLElement | null;         // textarea only
  marks: HTMLElement[];                // contenteditable only: live <lsd-ce-mark> wrappers
  applyingMarks: boolean;              // contenteditable only: suppress input feedback during rewrap
  debounceHandle: number | null;
  lastFindings: Finding[];
  lastText: string;
  resizeObserver: ResizeObserver | null;
};

const editors = new WeakMap<Element, EditorState>();
// Separate iterable registry so reflowAll() can walk every live editor.
// We prune entries when their editor leaves the DOM inside positionOverlays.
const editorRegistry = new Set<EditorEl>();
let rules: RuleSet;
let prefs: Prefs;
let popover: HTMLElement | null = null;
let activeEditorEl: EditorEl | null = null;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  prefs = await getPrefs();
  rules = buildRules(prefs.enabledPacks);
  injectStyles();
  // The page-scan message handler is always installed so the user can run a
  // read-only scan even on hosts where editor scanning is disabled (or when
  // editor scanning is off globally).
  installMessageHandler();

  const editorScanningOn = prefs.enabled && !isHostDisabled(prefs, HOST);
  if (editorScanningOn) {
    scanDocument();
    observeMutations();
  }

  onPrefsChanged(next => {
    const wasOn = prefs.enabled && !isHostDisabled(prefs, HOST);
    prefs = next;
    const isOn = prefs.enabled && !isHostDisabled(prefs, HOST);
    rules = buildRules(prefs.enabledPacks);

    if (!isOn && wasOn) {
      teardownEditors();
      return;
    }
    if (isOn && !wasOn) {
      // Re-init from scratch -- easier than tracking which editors we had.
      injectStyles();
      scanDocument();
      return;
    }
    if (isOn) {
      // Packs changed: rescan every known editor with the new rules.
      rescanAll();
    }
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

function teardownEditors() {
  for (const ed of editorRegistry) {
    const s = editors.get(ed);
    s?.resizeObserver?.disconnect();
    s?.badge.remove();
    s?.mirror?.remove();
    editors.delete(ed);
  }
  editorRegistry.clear();
  closePopover();
}

// ---------------------------------------------------------------------------
// Editor discovery
// ---------------------------------------------------------------------------

const TEXT_CONTROL_SELECTOR = 'textarea, input[type=text]';
const CE_SELECTOR = '[contenteditable="true"], [contenteditable=""]';
const ALL_EDITOR_SELECTOR = `${TEXT_CONTROL_SELECTOR}, ${CE_SELECTOR}`;

function attachAny(el: HTMLElement) {
  if (el.matches(TEXT_CONTROL_SELECTOR)) {
    attach(el);
  } else if (el.matches(CE_SELECTOR)) {
    attachContenteditable(el);
  }
}

function scanDocument() {
  document.querySelectorAll(ALL_EDITOR_SELECTOR).forEach(el => attachAny(el as HTMLElement));
}

function observeMutations() {
  const mo = new MutationObserver(mutations => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(ALL_EDITOR_SELECTOR)) attachAny(node);
        node.querySelectorAll?.(ALL_EDITOR_SELECTOR).forEach(el => attachAny(el as HTMLElement));
      });
      // An element may become contenteditable dynamically; the attribute
      // mutation case is rare and adds observer cost, so we skip it and
      // rely on initial sweep + childList additions only.
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
    marks: [],
    applyingMarks: false,
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

// ---------------------------------------------------------------------------
// Contenteditable path (#71)
// ---------------------------------------------------------------------------

const CE_MARK_TAG = 'lsd-ce-mark';

// Tags to skip while extracting plain text / fragments from a contenteditable.
// Broader than the read-only list because we're inside a user-controlled
// editor where script/style/etc. still shouldn't leak.
const CE_EXTRACT_SKIP = new Set([
  'script', 'style', 'noscript', 'template',
  'svg', 'math', 'video', 'audio', 'object', 'embed', 'canvas',
  'textarea', 'input',
]);

type CeFragment = { node: Text; textOffset: number };

function attachContenteditable(el: HTMLElement) {
  if (editors.has(el)) return;
  if (el.closest(`.${HOST_CLASS}`)) return;
  if (el.hasAttribute('data-slop-ignore')) return;
  // Don't re-attach to an element already inside an attached contenteditable
  // (nested ce elements are rare but real: e.g. Gmail quote blocks).
  for (const ed of editorRegistry) {
    if (ed !== el && ed.contains(el)) return;
  }
  // Minimum visible size guard so we don't attach to empty 0-height divs that
  // become contenteditable only when clicked.
  const rect = el.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 16) return;

  const badge = document.createElement('span');
  badge.className = `${HOST_CLASS} ${BADGE_CLASS} lsd-hidden`;
  badge.textContent = '0';
  badge.title = 'LLM Slop Detector';
  badge.setAttribute('role', 'button');
  badge.setAttribute('tabindex', '0');
  badge.addEventListener('click', e => { e.stopPropagation(); togglePopover(el); });
  badge.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePopover(el); }
  });
  document.body.appendChild(badge);

  const state: EditorState = {
    editor: el,
    kind: 'contenteditable',
    badge,
    mirror: null,
    marks: [],
    applyingMarks: false,
    debounceHandle: null,
    lastFindings: [],
    lastText: '',
    resizeObserver: null,
  };
  editors.set(el, state);
  editorRegistry.add(el);

  el.addEventListener('input', () => {
    // input fires on our own wrap mutations too (via execCommand fix and
    // the native DOM mutations). Skip when we know we caused it.
    if (state.applyingMarks) return;
    scheduleScan(state);
  });
  el.addEventListener('focus', () => positionOverlays(state));
  el.addEventListener('blur', () => {
    setTimeout(() => { if (document.activeElement !== badge) positionOverlays(state); }, 150);
  });

  if ('ResizeObserver' in window) {
    state.resizeObserver = new ResizeObserver(() => reflowAll());
    state.resizeObserver.observe(el);
  }

  installGlobalListeners();
  positionOverlays(state);
  runScanCe(state);
}

// Extract plain text from a contenteditable, alongside a fragment map from
// the extracted-text offset space back to the DOM text nodes. Our own
// <lsd-ce-mark> wrappers are descended into but produce no extra text, so
// the extracted string is stable across mark presence/absence.
function extractCeText(el: HTMLElement): { text: string; fragments: CeFragment[] } {
  let text = '';
  const fragments: CeFragment[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      fragments.push({ node: t, textOffset: text.length });
      text += t.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const elNode = node as Element;
    const tag = elNode.tagName.toLowerCase();
    if (tag === 'br') { text += '\n'; return; }
    if (CE_EXTRACT_SKIP.has(tag)) return;
    // Our own marker: descend transparently so extracted text ignores it.
    const isOurMark = tag === CE_MARK_TAG;
    const block = !isOurMark && isBlockElement(elNode);
    if (block && text.length > 0 && !text.endsWith('\n')) text += '\n';
    for (const child of Array.from(elNode.childNodes)) walk(child);
    if (block && !text.endsWith('\n')) text += '\n';
  };

  for (const child of Array.from(el.childNodes)) walk(child);
  return { text, fragments };
}

function isBlockElement(el: Element): boolean {
  const display = getComputedStyle(el).display;
  // Treat grid/flex containers as block for text-flow purposes too.
  return display === 'block' || display === 'flex' || display === 'grid' || display === 'list-item' || display === 'table';
}

function findFragmentAt(fragments: CeFragment[], textOffset: number): { frag: CeFragment; localOffset: number } | null {
  // Binary search would be nicer; linear is fine for typical fragment counts.
  for (let i = 0; i < fragments.length; i++) {
    const f = fragments[i];
    const len = f.node.nodeValue?.length ?? 0;
    const end = f.textOffset + len;
    if (textOffset >= f.textOffset && textOffset <= end) {
      return { frag: f, localOffset: textOffset - f.textOffset };
    }
  }
  return null;
}

function wrapCeFinding(fragments: CeFragment[], f: Finding, state: EditorState): HTMLElement | null {
  const start = findFragmentAt(fragments, f.offset);
  const end = findFragmentAt(fragments, f.offset + f.length);
  if (!start || !end) return null;

  // Same-text-node fast path.
  if (start.frag === end.frag) {
    return wrapCeRange(start.frag.node, start.localOffset, end.frag.node, end.localOffset, f);
  }

  // Cross-text-node: try a range that crosses element boundaries. Some will
  // fail via surroundContents (ranges that partially contain non-text nodes).
  return wrapCeRange(start.frag.node, start.localOffset, end.frag.node, end.localOffset, f);
}

function wrapCeRange(startNode: Text, startOffset: number, endNode: Text, endOffset: number, f: Finding): HTMLElement | null {
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const wrapper = document.createElement(CE_MARK_TAG);
    wrapper.className = `${CE_MARK_TAG} lsd-sev-${f.severity}`;
    wrapper.setAttribute('data-lsd-message', f.message);
    wrapper.setAttribute('data-lsd-offset', String(f.offset));
    range.surroundContents(wrapper);
    return wrapper;
  } catch {
    // Range crosses element boundaries (e.g. inline formatting splits the
    // phrase). Skipping the mark here means the finding still appears in
    // the popover's list, just without an inline mark. Acceptable v1.
    return null;
  }
}

function unwrapCeMarks(state: EditorState) {
  for (const m of state.marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  }
  state.marks = [];
  // Coalesce adjacent text nodes so next scan's fragment offsets are tidy.
  (state.editor as HTMLElement).normalize?.();
}

function getCeCaretOffset(fragments: CeFragment[]): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!r.collapsed) return null; // only preserve collapsed caret
  if (r.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const node = r.startContainer as Text;
  for (const f of fragments) {
    if (f.node === node) return f.textOffset + r.startOffset;
  }
  return null;
}

function setCeCaretOffset(fragments: CeFragment[], targetOffset: number) {
  const hit = findFragmentAt(fragments, targetOffset);
  if (!hit) return;
  try {
    const range = document.createRange();
    range.setStart(hit.frag.node, hit.localOffset);
    range.setEnd(hit.frag.node, hit.localOffset);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch { /* ignore */ }
}

function findingsEqual(a: Finding[], b: Finding[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].offset !== b[i].offset || a[i].length !== b[i].length || a[i].matchText !== b[i].matchText) return false;
  }
  return true;
}

function runScanCe(state: EditorState) {
  const el = state.editor as HTMLElement;
  if (!document.contains(el)) {
    state.badge.remove();
    state.resizeObserver?.disconnect();
    editors.delete(el);
    editorRegistry.delete(el);
    return;
  }

  const { text, fragments } = extractCeText(el);
  state.lastText = text;

  if (text.length > SIZE_CAP) {
    state.lastFindings = [];
    updateBadge(state, -1);
    if (state.marks.length > 0) {
      state.applyingMarks = true;
      unwrapCeMarks(state);
      state.applyingMarks = false;
    }
    return;
  }

  const findings = scanText(text, rules, LANGUAGE);

  if (findingsEqual(findings, state.lastFindings)) {
    // Text may have changed (user typed whitespace) but findings are the
    // same -- skip the DOM dance to avoid flickering marks.
    state.lastFindings = findings;
    updateBadge(state, findings.length);
    if (popover && activeEditorEl === el) renderPopover(state);
    return;
  }

  state.lastFindings = findings;
  updateBadge(state, findings.length);

  const caretOffset = getCeCaretOffset(fragments);

  state.applyingMarks = true;
  unwrapCeMarks(state);
  const { fragments: fresh } = extractCeText(el);
  // Wrap right-to-left so earlier offsets stay valid across splits.
  const sorted = [...findings].sort((a, b) => b.offset - a.offset);
  const wrapped: HTMLElement[] = [];
  let minStart = Infinity;
  for (const f of sorted) {
    if (f.offset + f.length > minStart) continue;
    const mark = wrapCeFinding(fresh, f, state);
    if (mark) {
      wrapped.push(mark);
      minStart = f.offset;
    }
  }
  state.marks = wrapped;
  state.applyingMarks = false;

  if (caretOffset !== null) {
    const { fragments: final } = extractCeText(el);
    setCeCaretOffset(final, caretOffset);
  }

  if (popover && activeEditorEl === el) renderPopover(state);
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
  const edHit = findMarkAtPoint(x, y);
  if (edHit) {
    const key = `ed:${edHit.mirrorKey}:${edHit.offset}`;
    const msg = edHit.mark.getAttribute('data-lsd-message') || '';
    showTooltip(msg, x, y, key);
    return;
  }
  const ceHit = findCeMarkAtPoint(x, y);
  if (ceHit) {
    const key = `ce:${ceHit.offset}`;
    const msg = ceHit.mark.getAttribute('data-lsd-message') || '';
    showTooltip(msg, x, y, key);
    return;
  }
  const rdHit = findRdMarkAtPoint(x, y);
  if (rdHit) {
    const key = `rd:${rdHit.index}`;
    const msg = rdHit.element.getAttribute('data-lsd-message') || '';
    showTooltip(msg, x, y, key);
    return;
  }
  hideTooltip();
}

function onDocClick(e: MouseEvent) {
  // Ignore clicks inside our own popover / panel / badge so they don't
  // retrigger the jump when the user interacts with our own UI.
  const target = e.target as HTMLElement | null;
  if (target?.closest(`.${HOST_CLASS}`)) return;

  const edHit = findMarkAtPoint(e.clientX, e.clientY);
  if (edHit) {
    const state = edHit.state;
    if (!popover || activeEditorEl !== state.editor) openPopover(state);
    if (edHit.offset >= 0) highlightPopoverFinding(edHit.offset);
    return;
  }

  const ceHit = findCeMarkAtPoint(e.clientX, e.clientY);
  if (ceHit) {
    const state = ceHit.state;
    if (!popover || activeEditorEl !== state.editor) openPopover(state);
    if (ceHit.offset >= 0) highlightPopoverFinding(ceHit.offset);
    return;
  }

  const rdHit = findRdMarkAtPoint(e.clientX, e.clientY);
  if (rdHit) {
    jumpToRdFinding(rdHit);
    return;
  }
}

function findCeMarkAtPoint(x: number, y: number): { state: EditorState; mark: HTMLElement; offset: number } | null {
  for (const ed of editorRegistry) {
    const s = editors.get(ed);
    if (!s || s.kind !== 'contenteditable') continue;
    if (s.marks.length === 0) continue;
    const outer = (s.editor as HTMLElement).getBoundingClientRect();
    if (x < outer.left || x > outer.right || y < outer.top || y > outer.bottom) continue;
    for (const mark of s.marks) {
      const rects = mark.getClientRects();
      for (const r of rects) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const offset = parseInt(mark.getAttribute('data-lsd-offset') || '-1', 10);
          return { state: s, mark, offset };
        }
      }
    }
  }
  return null;
}

function findRdMarkAtPoint(x: number, y: number): RdFinding | null {
  for (const rf of rdFindings) {
    const rects = rf.element.getClientRects();
    for (const r of rects) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return rf;
    }
  }
  return null;
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
    if (state.kind === 'contenteditable') runScanCe(state);
    else runScan(state);
  }, DEBOUNCE_MS);
}

function runScan(state: EditorState) {
  const editor = state.editor as TextControl;
  const text = editor.value ?? '';
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

function togglePopover(editor: EditorEl) {
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
  const editor = state.editor as TextControl;
  const proto = state.kind === 'textarea'
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(editor, next);
  } else {
    editor.value = next;
  }
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyCharFix(state: EditorState, finding: Finding) {
  if (finding.code !== 'char') return;
  const def = rules.chars.get(finding.matchText);
  if (!def || def.replacement === undefined) return;

  if (state.kind === 'contenteditable') {
    applyCeCharFix(state, finding, def.replacement);
    return;
  }

  const editor = state.editor as TextControl;
  const current = editor.value;
  const next = current.slice(0, finding.offset) + def.replacement + current.slice(finding.offset + finding.length);
  setEditorValue(state, next);
  editor.focus();
  const caret = finding.offset + def.replacement.length;
  try { editor.setSelectionRange(caret, caret); } catch { /* some inputs don't support */ }
  // runScan is triggered by the input event.
}

function applyAllCharFixes(state: EditorState) {
  const fixable = state.lastFindings
    .filter(f => f.code === 'char')
    .map(f => {
      const def = rules.chars.get(f.matchText);
      return def?.replacement !== undefined
        ? { offset: f.offset, length: f.length, replacement: def.replacement }
        : null;
    })
    .filter((x): x is { offset: number; length: number; replacement: string } => x !== null)
    .sort((a, b) => b.offset - a.offset); // right-to-left preserves offsets

  if (fixable.length === 0) return;

  if (state.kind === 'contenteditable') {
    // Apply each one via execCommand so the undo stack sees N discrete
    // edits. Doing a single big insertText would lose finding-level undo.
    const el = state.editor as HTMLElement;
    el.focus();
    for (const fx of fixable) applyCeFixAtOffset(el, fx.offset, fx.length, fx.replacement);
    // scheduleScan will fire via input events; no extra rescan needed.
    return;
  }

  const editor = state.editor as TextControl;
  let next = editor.value;
  for (const fx of fixable) {
    next = next.slice(0, fx.offset) + fx.replacement + next.slice(fx.offset + fx.length);
  }
  setEditorValue(state, next);
  editor.focus();
}

function applyCeCharFix(state: EditorState, finding: Finding, replacement: string) {
  const el = state.editor as HTMLElement;
  el.focus();
  applyCeFixAtOffset(el, finding.offset, finding.length, replacement);
}

// Sets the selection to the given extracted-text offset range inside a
// contenteditable and runs execCommand('insertText'). Using execCommand
// instead of direct DOM surgery preserves the undo stack (Cmd+Z in Gmail
// works naturally) and lets the host framework react via its own input
// handler.
function applyCeFixAtOffset(el: HTMLElement, offset: number, length: number, replacement: string) {
  const { fragments } = extractCeText(el);
  const start = findFragmentAt(fragments, offset);
  const end = findFragmentAt(fragments, offset + length);
  if (!start || !end) return;
  try {
    const range = document.createRange();
    range.setStart(start.frag.node, start.localOffset);
    range.setEnd(end.frag.node, end.localOffset);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // execCommand is deprecated but remains the only reliable way to
    // insert text into a contenteditable while preserving the undo stack.
    document.execCommand('insertText', false, replacement);
  } catch { /* selection failed; skip */ }
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

    /* ---- Contenteditable marks ---- */
    ${CE_MARK_TAG} {
      /* Wavy underline that matches the read-only mark style: keeps the
         text legible in a writing context and doesn't disturb selection
         gestures since we leave pointer-events at default (but clicks
         bubble through to the contenteditable). */
      text-decoration: underline wavy !important;
      text-underline-offset: 2px !important;
      text-decoration-thickness: 1.5px !important;
      pointer-events: none !important;
    }
    ${CE_MARK_TAG}.lsd-sev-error       { text-decoration-color: #d73a49 !important; }
    ${CE_MARK_TAG}.lsd-sev-warning     { text-decoration-color: #b08800 !important; }
    ${CE_MARK_TAG}.lsd-sev-information { text-decoration-color: #0366d6 !important; }
    ${CE_MARK_TAG}.lsd-sev-hint        { text-decoration-color: #6a737d !important; }

    /* ---- Read-only page scan ---- */
    ${RD_MARK_TAG} {
      border-radius: 2px !important;
      /* Subtle styling: a thin underline so reading flow isn't disrupted as
         badly as a background wash. Colour by severity. */
      text-decoration: underline wavy !important;
      text-underline-offset: 2px !important;
      text-decoration-thickness: 1.5px !important;
      cursor: help !important;
    }
    ${RD_MARK_TAG}.lsd-sev-error       { text-decoration-color: #d73a49 !important; }
    ${RD_MARK_TAG}.lsd-sev-warning     { text-decoration-color: #b08800 !important; }
    ${RD_MARK_TAG}.lsd-sev-information { text-decoration-color: #0366d6 !important; }
    ${RD_MARK_TAG}.lsd-sev-hint        { text-decoration-color: #6a737d !important; }
    @keyframes lsd-rd-pulse {
      0%   { background: rgba(3, 102, 214, 0.5); }
      100% { background: transparent; }
    }
    ${RD_MARK_TAG}.lsd-pulse {
      animation: lsd-rd-pulse 1400ms ease-out 1 !important;
      border-radius: 3px !important;
    }

    .${RD_PANEL_CLASS} {
      position: fixed !important;
      right: 16px !important;
      bottom: 16px !important;
      width: 340px !important;
      max-height: 70vh !important;
      display: flex !important;
      flex-direction: column !important;
      z-index: 2147483641 !important;
      background: #ffffff !important;
      color: #1c1c1c !important;
      border: 1px solid #d9d9d4 !important;
      border-radius: 6px !important;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18) !important;
      font-size: 13px !important;
      line-height: 1.4 !important;
    }
    @media (prefers-color-scheme: dark) {
      .${RD_PANEL_CLASS} {
        background: #1c1f24 !important;
        color: #e6e6e6 !important;
        border-color: #2a2d33 !important;
      }
    }
    .${RD_PANEL_CLASS} .lsd-rd-head {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      padding: 6px 10px !important;
      border-bottom: 1px solid #e5e5e0 !important;
    }
    @media (prefers-color-scheme: dark) {
      .${RD_PANEL_CLASS} .lsd-rd-head { border-bottom-color: #2a2d33 !important; }
    }
    .${RD_PANEL_CLASS} .lsd-rd-title { font-weight: 600 !important; font-size: 12px !important; }
    .${RD_PANEL_CLASS} .lsd-rd-close {
      all: unset !important;
      cursor: pointer !important;
      padding: 2px 6px !important;
      border-radius: 3px !important;
      opacity: 0.7 !important;
    }
    .${RD_PANEL_CLASS} .lsd-rd-close:hover { opacity: 1 !important; background: rgba(127,127,127,0.15) !important; }
    .${RD_PANEL_CLASS} .lsd-rd-summary {
      padding: 6px 10px !important;
      border-bottom: 1px solid #e5e5e0 !important;
      font-size: 12px !important;
    }
    @media (prefers-color-scheme: dark) {
      .${RD_PANEL_CLASS} .lsd-rd-summary { border-bottom-color: #2a2d33 !important; }
    }
    .${RD_PANEL_CLASS} .lsd-rd-counts { font-size: 14px !important; }
    .${RD_PANEL_CLASS} .lsd-rd-sevbits { margin-top: 4px !important; display: flex !important; gap: 6px !important; flex-wrap: wrap !important; }
    .${RD_PANEL_CLASS} .lsd-rd-sev {
      font-size: 11px !important;
      padding: 1px 6px !important;
      border-radius: 3px !important;
      color: #fff !important;
    }
    .${RD_PANEL_CLASS} .lsd-rd-sev.lsd-sev-error       { background: #d73a49 !important; }
    .${RD_PANEL_CLASS} .lsd-rd-sev.lsd-sev-warning     { background: #b08800 !important; }
    .${RD_PANEL_CLASS} .lsd-rd-sev.lsd-sev-information { background: #0366d6 !important; }
    .${RD_PANEL_CLASS} .lsd-rd-sev.lsd-sev-hint        { background: #6a737d !important; }
    .${RD_PANEL_CLASS} .lsd-rd-cap {
      margin-top: 6px !important;
      padding: 4px 6px !important;
      background: rgba(176, 136, 0, 0.15) !important;
      border-radius: 3px !important;
      font-size: 11px !important;
    }
    .${RD_PANEL_CLASS} .lsd-rd-empty {
      color: #666 !important;
      padding: 4px 0 !important;
      font-style: italic !important;
    }
    .${RD_PANEL_CLASS} .lsd-rd-list {
      overflow-y: auto !important;
      padding: 6px 10px !important;
      flex: 1 !important;
    }
    .${RD_PANEL_CLASS} .lsd-rd-item {
      padding: 6px 8px !important;
      margin-bottom: 6px !important;
      border-left: 3px solid #d9d9d4 !important;
      border-radius: 3px !important;
      background: rgba(127,127,127,0.05) !important;
      cursor: pointer !important;
    }
    .${RD_PANEL_CLASS} .lsd-rd-item:hover { background: rgba(127,127,127,0.12) !important; }
    .${RD_PANEL_CLASS} .lsd-rd-item.lsd-sev-error       { border-left-color: #d73a49 !important; }
    .${RD_PANEL_CLASS} .lsd-rd-item.lsd-sev-warning     { border-left-color: #b08800 !important; }
    .${RD_PANEL_CLASS} .lsd-rd-item.lsd-sev-information { border-left-color: #0366d6 !important; }
    .${RD_PANEL_CLASS} .lsd-rd-item.lsd-sev-hint        { border-left-color: #6a737d !important; }
    .${RD_PANEL_CLASS} .lsd-rd-item-head {
      display: flex !important; gap: 6px !important; align-items: center !important;
      flex-wrap: wrap !important; margin-bottom: 4px !important;
    }
    .${RD_PANEL_CLASS} .lsd-rd-actions {
      padding: 6px 10px !important;
      border-top: 1px solid #e5e5e0 !important;
    }
    @media (prefers-color-scheme: dark) {
      .${RD_PANEL_CLASS} .lsd-rd-actions { border-top-color: #2a2d33 !important; }
    }
    .${RD_PANEL_CLASS} .lsd-rd-clear {
      all: unset !important;
      font: inherit !important;
      font-size: 12px !important;
      padding: 3px 8px !important;
      background: rgba(215, 58, 73, 0.15) !important;
      color: #d73a49 !important;
      border-radius: 3px !important;
      cursor: pointer !important;
      font-weight: 600 !important;
    }
    .${RD_PANEL_CLASS} .lsd-rd-clear:hover { background: rgba(215, 58, 73, 0.25) !important; }
  `;
  document.documentElement.appendChild(style);
}

// ---------------------------------------------------------------------------
// Read-only page scan (#69)
// ---------------------------------------------------------------------------

const RD_MARK_TAG = 'lsd-rd-mark';
const RD_PANEL_CLASS = 'lsd-rd-panel';
const RD_TOTAL_CAP = 500 * 1024;
const RD_MIN_NODE_CHARS = 12;

// Elements whose text we never scan in read-only mode. Script/style is a
// parse-safety thing; pre/code/kbd/samp/tt/var are technical and would false-
// positive on terminology; textarea/input are covered by the editor path;
// template/iframe/svg/math/canvas either hide text or aren't useful.
const RD_SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe',
  'textarea', 'input', 'code', 'pre', 'samp', 'kbd', 'tt', 'var',
  'svg', 'math', 'video', 'audio', 'object', 'embed', 'canvas',
]);

type RdFinding = { finding: Finding; element: HTMLElement; index: number };
let rdFindings: RdFinding[] = [];
let rdPanel: HTMLElement | null = null;

function installMessageHandler() {
  const api = (globalThis as any).browser ?? (globalThis as any).chrome;
  api.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: (r: unknown) => void) => {
    if (msg?.type === 'lsd:runPageScan') {
      runPageScan();
      sendResponse({ ok: true });
    } else if (msg?.type === 'lsd:clearPageScan') {
      clearPageScan();
      sendResponse({ ok: true });
    }
    // Return value matters for cross-browser compatibility:
    // - Chrome MV3: return true keeps the response channel open for async
    //   sendResponse; falsy closes it. We call sendResponse synchronously
    //   above, so false is correct.
    // - Firefox: same semantics for the falsy case.
    return false;
  });
}

function runPageScan() {
  if (!prefs.readOnlyEnabled) return;
  clearPageScan();

  const texts = collectReadOnlyTextNodes(document.body);
  let totalScanned = 0;
  let capHit = false;

  for (const node of texts) {
    if (!node.parentNode) continue; // removed between collection and wrap
    const text = node.nodeValue ?? '';
    if (text.length === 0) continue;
    if (totalScanned + text.length > RD_TOTAL_CAP) { capHit = true; break; }
    totalScanned += text.length;

    const findings = scanText(text, rules, 'plaintext');
    if (findings.length === 0) continue;

    // Right-to-left so earlier offsets remain valid as we split the text
    // node from the right. Skip findings that overlap with a later-wrapped
    // range (shouldn't happen with current rules but is cheap insurance).
    const sorted = [...findings].sort((a, b) => b.offset - a.offset);
    let lastStart = Infinity;
    for (const f of sorted) {
      if (f.offset + f.length > lastStart) continue;
      const mark = wrapTextNodeRange(node, f.offset, f.length, f.severity, f.message);
      if (!mark) continue;
      lastStart = f.offset;
      rdFindings.push({ finding: f, element: mark, index: rdFindings.length });
    }
  }

  // Sort results by document order so "jump next" feels like reading.
  rdFindings.sort((a, b) => compareNodePositions(a.element, b.element));
  rdFindings.forEach((rf, i) => { rf.index = i; rf.element.setAttribute('data-lsd-rd-index', String(i)); });

  renderResultsPanel(capHit, totalScanned);
}

function collectReadOnlyTextNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        if (RD_SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        // Our own injected DOM, or a user editor we've attached to.
        if (el.classList.contains(HOST_CLASS)) return NodeFilter.FILTER_REJECT;
        const ce = el.getAttribute('contenteditable');
        if (ce === '' || ce === 'true' || ce === 'plaintext-only') return NodeFilter.FILTER_REJECT;
        // Hidden subtrees.
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      const t = node as Text;
      const v = t.nodeValue ?? '';
      if (v.trim().length < RD_MIN_NODE_CHARS) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) out.push(n as Text);
  }
  return out;
}

function wrapTextNodeRange(node: Text, offset: number, length: number, severity: Severity, message: string): HTMLElement | null {
  try {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + length);
    const wrapper = document.createElement(RD_MARK_TAG);
    wrapper.className = `lsd-rd-mark lsd-sev-${severity}`;
    wrapper.setAttribute('data-lsd-message', message);
    range.surroundContents(wrapper);
    return wrapper;
  } catch {
    return null;
  }
}

function compareNodePositions(a: Node, b: Node): number {
  if (a === b) return 0;
  const pos = a.compareDocumentPosition(b);
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function clearPageScan() {
  for (const rf of rdFindings) {
    const el = rf.element;
    const parent = el.parentNode;
    if (!parent) continue;
    // Unwrap: move children out, remove the wrapper.
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize?.();
  }
  rdFindings = [];
  rdPanel?.remove();
  rdPanel = null;
}

function renderResultsPanel(capHit: boolean, bytesScanned: number) {
  const panel = document.createElement('div');
  panel.className = `${HOST_CLASS} ${RD_PANEL_CLASS}`;
  panel.innerHTML = `
    <div class="lsd-rd-head">
      <span class="lsd-rd-title">Page scan</span>
      <button class="lsd-rd-close" type="button" aria-label="Close">x</button>
    </div>
    <div class="lsd-rd-summary"></div>
    <div class="lsd-rd-list"></div>
    <div class="lsd-rd-actions">
      <button class="lsd-rd-clear" type="button">Clear highlights</button>
    </div>
  `;
  document.body.appendChild(panel);
  rdPanel = panel;

  const counts: Record<Severity, number> = { error: 0, warning: 0, information: 0, hint: 0 };
  for (const rf of rdFindings) counts[rf.finding.severity]++;

  const summary = panel.querySelector('.lsd-rd-summary') as HTMLElement;
  const total = rdFindings.length;
  const sevBits = (['error', 'warning', 'information', 'hint'] as Severity[])
    .filter(s => counts[s] > 0)
    .map(s => `<span class="lsd-rd-sev lsd-sev-${s}">${counts[s]} ${s}</span>`)
    .join(' ');
  const capBit = capHit
    ? `<div class="lsd-rd-cap">Page exceeded ${RD_TOTAL_CAP / 1024} KB -- scanned first ${Math.round(bytesScanned / 1024)} KB.</div>`
    : '';
  summary.innerHTML = total === 0
    ? '<div class="lsd-rd-empty">No slop detected on this page.</div>'
    : `<div class="lsd-rd-counts"><strong>${total}</strong> finding${total === 1 ? '' : 's'}</div><div class="lsd-rd-sevbits">${sevBits}</div>${capBit}`;

  const list = panel.querySelector('.lsd-rd-list') as HTMLElement;
  for (const rf of rdFindings) {
    const row = document.createElement('div');
    row.className = `lsd-rd-item lsd-sev-${rf.finding.severity}`;
    row.innerHTML = `
      <div class="lsd-rd-item-head">
        <span class="lsd-badge-sev lsd-sev-${escapeAttr(rf.finding.severity)}">${escapeText(rf.finding.severity)}</span>
        <code class="lsd-match">${escapeText(rf.finding.matchText || '(empty)')}</code>
      </div>
      <div class="lsd-msg">${escapeText(rf.finding.message)}</div>
    `;
    row.addEventListener('click', () => jumpToRdFinding(rf));
    list.appendChild(row);
  }

  (panel.querySelector('.lsd-rd-close') as HTMLElement).addEventListener('click', () => {
    panel.remove();
    rdPanel = null;
  });
  (panel.querySelector('.lsd-rd-clear') as HTMLElement).addEventListener('click', () => {
    clearPageScan();
  });
}

function jumpToRdFinding(rf: RdFinding) {
  rf.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  rf.element.classList.remove('lsd-pulse');
  void rf.element.offsetWidth;
  rf.element.classList.add('lsd-pulse');
  window.setTimeout(() => rf.element.classList.remove('lsd-pulse'), 1500);
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

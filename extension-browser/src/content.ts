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
const STYLE_ID = 'lsd-style';

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
  debounceHandle: number | null;
  lastFindings: Finding[];
  lastText: string;
  resizeObserver: ResizeObserver | null;
};

const editors = new WeakMap<Element, EditorState>();
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
    debounceHandle: null,
    lastFindings: [],
    lastText: '',
    resizeObserver: null,
  };
  editors.set(el, state);

  editor.addEventListener('input', () => scheduleScan(state));
  editor.addEventListener('focus', () => positionBadge(state));
  editor.addEventListener('blur', () => {
    // Delay so a click on the badge isn't swallowed by blur.
    setTimeout(() => { if (document.activeElement !== badge) positionBadge(state); }, 150);
  });
  window.addEventListener('scroll', () => positionBadge(state), { passive: true, capture: true });
  window.addEventListener('resize', () => positionBadge(state), { passive: true });

  // Re-position when the editor resizes (user drag, autogrow).
  if ('ResizeObserver' in window) {
    state.resizeObserver = new ResizeObserver(() => positionBadge(state));
    state.resizeObserver.observe(editor);
  }

  runScan(state);
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
    return;
  }
  state.lastFindings = scanText(text, rules, LANGUAGE);
  updateBadge(state, state.lastFindings.length);
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
  positionBadge(state);
}

function positionBadge(state: EditorState) {
  const { editor, badge } = state;
  if (!document.contains(editor)) {
    badge.remove();
    state.resizeObserver?.disconnect();
    editors.delete(editor);
    return;
  }
  const rect = editor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    badge.style.display = 'none';
    return;
  }
  badge.style.display = '';
  // Anchor to bottom-right of the editor, inset a bit.
  const top = Math.max(0, rect.bottom + window.scrollY - 22);
  const left = Math.max(0, rect.right + window.scrollX - 32);
  badge.style.top = `${top}px`;
  badge.style.left = `${left}px`;
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
    <div class="lsd-pop-body"></div>
  `;
  document.body.appendChild(pop);
  popover = pop;
  activeEditorEl = state.editor;

  pop.querySelector('.lsd-pop-close')!.addEventListener('click', closePopover);
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
  const findings = state.lastFindings;
  if (findings.length === 0) {
    body.innerHTML = '<div class="lsd-empty">No slop detected.</div>';
    return;
  }
  const sorted = [...findings].sort((a, b) => a.offset - b.offset);
  body.innerHTML = '';
  for (const f of sorted) {
    const item = document.createElement('div');
    item.className = `lsd-item lsd-sev-${f.severity}`;
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

// ---------------------------------------------------------------------------
// Fix application
// ---------------------------------------------------------------------------

function applyCharFix(state: EditorState, finding: Finding) {
  if (finding.code !== 'char') return;
  const def = rules.chars.get(finding.matchText);
  if (!def || def.replacement === undefined) return;
  const { editor } = state;
  // Use the native value setter so React / Vue / Lit see the change.
  const proto = state.kind === 'textarea'
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const current = editor.value;
  const next = current.slice(0, finding.offset) + def.replacement + current.slice(finding.offset + finding.length);
  if (setter) {
    setter.call(editor, next);
  } else {
    editor.value = next;
  }
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.focus();
  const caret = finding.offset + def.replacement.length;
  try { editor.setSelectionRange(caret, caret); } catch { /* some inputs don't support */ }
  // runScan is triggered by the input event.
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
    .${BADGE_CLASS}.lsd-hidden { display: none !important; }
    .${BADGE_CLASS}.lsd-warn { background: #d73a49 !important; }
    .${BADGE_CLASS}:hover { filter: brightness(1.1); }
    .${BADGE_CLASS}:focus-visible { outline: 2px solid #0366d6 !important; outline-offset: 1px; }

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

import { BUILTIN_PACKS, loadRules } from '../src/core/rules';
import { scanText, offsetToLineCol, Language } from '../src/core/scan';
import { Finding, RuleSet, Severity } from '../src/core/types';
import { BUILTIN_RAW, PACK_RAWS } from './rules.generated';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'llm-slop-detector:v1';

type Prefs = {
  language: Language;
  enabledPacks: string[];
};

const DEFAULTS: Prefs = { language: 'markdown', enabledPacks: [] };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      language: parsed.language === 'plaintext' ? 'plaintext' : 'markdown',
      enabledPacks: Array.isArray(parsed.enabledPacks)
        ? parsed.enabledPacks.filter((p: unknown) => typeof p === 'string' && (BUILTIN_PACKS as readonly string[]).includes(p as string))
        : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(p: Prefs) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* quota */ }
}

// ---------------------------------------------------------------------------
// Rule set
// ---------------------------------------------------------------------------

function buildRuleSet(enabledPacks: string[]): RuleSet {
  const lists: Array<{ origin: string; raw: any }> = [
    { origin: 'built-in', raw: BUILTIN_RAW },
  ];
  const allowed = new Set<string>(BUILTIN_PACKS);
  for (const pack of enabledPacks) {
    if (!allowed.has(pack)) continue;
    const raw = PACK_RAWS[pack];
    if (raw) lists.push({ origin: `pack:${pack}`, raw });
  }
  return loadRules({
    lists,
    userPhrases: [],
    charReplacements: {},
    severityOverrides: {},
  });
}

// ---------------------------------------------------------------------------
// Fix application (deterministic char replacements only)
// ---------------------------------------------------------------------------

function applyCharFixes(text: string, findings: Finding[], rules: RuleSet): string {
  const charFixes = findings
    .filter(f => f.code === 'char')
    .map(f => {
      const def = rules.chars.get(f.matchText);
      return def?.replacement !== undefined ? { offset: f.offset, length: f.length, replacement: def.replacement } : null;
    })
    .filter((x): x is { offset: number; length: number; replacement: string } => x !== null)
    .sort((a, b) => b.offset - a.offset); // apply right-to-left so offsets stay valid

  let out = text;
  for (const fx of charFixes) {
    out = out.slice(0, fx.offset) + fx.replacement + out.slice(fx.offset + fx.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderHighlighted(text: string, findings: Finding[]): string {
  if (findings.length === 0) return escapeHtml(text);
  const sorted = [...findings].sort((a, b) => a.offset - b.offset);
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    if (f.offset < cursor) continue; // skip overlaps
    if (f.offset > cursor) parts.push(escapeHtml(text.slice(cursor, f.offset)));
    const display = f.matchText.length === 0 ? '' : escapeHtml(f.matchText);
    parts.push(`<mark class="sev-${f.severity} code-${f.code}" data-finding-idx="${i}" title="${escapeHtml(f.message)}">${display}</mark>`);
    cursor = f.offset + f.length;
  }
  if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
  return parts.join('');
}

function renderFindingsList(container: HTMLElement, findings: Finding[], text: string, rules: RuleSet) {
  container.innerHTML = '';
  if (findings.length === 0) {
    container.innerHTML = '<li class="empty">No slop detected.</li>';
    return;
  }
  const sorted = [...findings].sort((a, b) => a.offset - b.offset);
  for (const f of sorted) {
    const { line, col } = offsetToLineCol(text, f.offset);
    const li = document.createElement('li');
    li.className = `finding sev-${f.severity}`;
    const def = f.code === 'char' ? rules.chars.get(f.matchText) : undefined;
    const hasFix = def?.replacement !== undefined;
    li.innerHTML = `
      <div class="finding-head">
        <span class="badge sev-${f.severity}">${f.severity}</span>
        <span class="loc">${line}:${col}</span>
        <code class="match">${escapeHtml(f.matchText || '(empty)')}</code>
      </div>
      <div class="msg">${escapeHtml(f.message)}</div>
      ${hasFix ? `<button class="fix-one" data-offset="${f.offset}" data-length="${f.length}">Fix this</button>` : ''}
    `;
    container.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const SAMPLE = [
  "Let's delve into this -- it's a truly game-changing paradigm shift.",
  "",
  "We'll leverage our robust framework to unlock seamless synergy across the organisation.",
  "",
  "Ultimately, this tapestry of cutting-edge capabilities will empower teams to navigate the multifaceted landscape.",
  "",
  "That said, it's worth noting that the devil is in the details.",
].join('\n');

function init() {
  const prefs = loadPrefs();

  const textarea = $('input') as HTMLTextAreaElement;
  const preview = $('preview');
  const findingsList = $('findings');
  const summary = $('summary');
  const langSelect = $('language') as HTMLSelectElement;
  const packList = $('packs');
  const fixAllBtn = $('fix-all') as HTMLButtonElement;
  const copyBtn = $('copy-fixed') as HTMLButtonElement;
  const sampleBtn = $('paste-sample') as HTMLButtonElement;
  const clearBtn = $('clear') as HTMLButtonElement;
  const sizeCap = 200 * 1024;

  // Pack checkboxes
  for (const pack of BUILTIN_PACKS) {
    const id = `pack-${pack}`;
    const label = document.createElement('label');
    label.className = 'pack';
    label.innerHTML = `<input type="checkbox" id="${id}" value="${pack}"> ${pack}`;
    packList.appendChild(label);
    const cb = label.querySelector('input') as HTMLInputElement;
    cb.checked = prefs.enabledPacks.includes(pack);
    cb.addEventListener('change', () => {
      const enabled = [...packList.querySelectorAll('input[type=checkbox]:checked')].map(i => (i as HTMLInputElement).value);
      prefs.enabledPacks = enabled;
      savePrefs(prefs);
      rules = buildRuleSet(prefs.enabledPacks);
      rescan();
    });
  }

  langSelect.value = prefs.language;
  langSelect.addEventListener('change', () => {
    prefs.language = langSelect.value as Language;
    savePrefs(prefs);
    rescan();
  });

  let rules = buildRuleSet(prefs.enabledPacks);
  let lastFindings: Finding[] = [];
  let debounceHandle: number | null = null;

  function rescan() {
    const text = textarea.value;
    if (text.length > sizeCap) {
      preview.textContent = '';
      findingsList.innerHTML = '';
      summary.textContent = `Input exceeds ${sizeCap / 1024} KB -- paste smaller chunks.`;
      summary.className = 'summary warn';
      fixAllBtn.disabled = true;
      copyBtn.disabled = true;
      return;
    }
    lastFindings = scanText(text, rules, prefs.language);
    preview.innerHTML = renderHighlighted(text, lastFindings);
    renderFindingsList(findingsList, lastFindings, text, rules);

    const counts: Record<Severity, number> = { error: 0, warning: 0, information: 0, hint: 0 };
    for (const f of lastFindings) counts[f.severity]++;
    if (lastFindings.length === 0) {
      summary.textContent = text.length === 0 ? 'Paste text above to scan.' : 'Looks clean.';
      summary.className = 'summary clean';
    } else {
      const bits = [
        `${lastFindings.length} finding${lastFindings.length === 1 ? '' : 's'}`,
        counts.error ? `${counts.error} error` : '',
        counts.warning ? `${counts.warning} warning` : '',
        counts.information ? `${counts.information} info` : '',
        counts.hint ? `${counts.hint} hint` : '',
      ].filter(Boolean);
      summary.textContent = bits.join(' -- ');
      summary.className = 'summary dirty';
    }

    const fixable = lastFindings.some(f => f.code === 'char' && rules.chars.get(f.matchText)?.replacement !== undefined);
    fixAllBtn.disabled = !fixable;
    copyBtn.disabled = !fixable;
  }

  function scheduleScan() {
    if (debounceHandle !== null) window.clearTimeout(debounceHandle);
    debounceHandle = window.setTimeout(() => {
      debounceHandle = null;
      rescan();
    }, 120);
  }

  textarea.addEventListener('input', scheduleScan);

  fixAllBtn.addEventListener('click', () => {
    const next = applyCharFixes(textarea.value, lastFindings, rules);
    textarea.value = next;
    rescan();
    textarea.focus();
  });

  copyBtn.addEventListener('click', async () => {
    const next = applyCharFixes(textarea.value, lastFindings, rules);
    try {
      await navigator.clipboard.writeText(next);
      copyBtn.textContent = 'Copied!';
      window.setTimeout(() => { copyBtn.textContent = 'Copy fixed text'; }, 1500);
    } catch {
      copyBtn.textContent = 'Clipboard blocked';
      window.setTimeout(() => { copyBtn.textContent = 'Copy fixed text'; }, 1500);
    }
  });

  findingsList.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.fix-one') as HTMLButtonElement | null;
    if (!btn) return;
    const offset = Number(btn.dataset.offset);
    const length = Number(btn.dataset.length);
    const f = lastFindings.find(x => x.offset === offset && x.length === length);
    if (!f) return;
    const def = rules.chars.get(f.matchText);
    if (!def || def.replacement === undefined) return;
    textarea.value = textarea.value.slice(0, offset) + def.replacement + textarea.value.slice(offset + length);
    rescan();
    textarea.focus();
    textarea.setSelectionRange(offset + def.replacement.length, offset + def.replacement.length);
  });

  sampleBtn.addEventListener('click', () => {
    textarea.value = SAMPLE;
    rescan();
    textarea.focus();
  });

  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    rescan();
    textarea.focus();
  });

  rescan();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

import { CharRule, PhraseRule, RuleSet, Severity, SeverityOverride } from './types';

export const LOCAL_RULES_FILENAME = '.llmsloprc.json';

export const BUILTIN_PACKS = ['academic', 'cliches', 'fiction', 'claudeisms', 'structural', 'security', 'gemini', 'deepseek', 'llama', 'qwen', 'grok'] as const;
export type BuiltinPack = typeof BUILTIN_PACKS[number];

type RawCharRule = {
  char?: unknown;
  name?: unknown;
  severity?: unknown;
  replacement?: unknown;
  suggestion?: unknown;
};

type RawPhraseRule = {
  pattern?: unknown;
  reason?: unknown;
  severity?: unknown;
};

export type RawList = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  chars?: unknown;
  phrases?: unknown;
  [key: string]: unknown;
};

export type LoadOptions = {
  lists: Array<{ origin: string; raw: RawList }>;
  userPhrases: string[];
  charReplacements: Record<string, string>;
  severityOverrides: Record<string, SeverityOverride>;
};

function parseSeverity(s: unknown, fallback: Severity): Severity {
  switch (s) {
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'information':
    case 'info': return 'information';
    case 'hint': return 'hint';
    default: return fallback;
  }
}

// Chars in the invisible/zero-width ranges are dangerous (hide in text,
// break diffs, enable Trojan Source attacks); visible punctuation is merely suspicious.
function defaultCharSeverity(char: string): Severity {
  const code = char.codePointAt(0)!;
  const invisible =
    code === 0x00AD ||
    code === 0x00A0 ||
    code === 0x1160 ||
    code === 0x180E ||
    (code >= 0x200B && code <= 0x200F) ||
    (code >= 0x202A && code <= 0x202E) ||
    code === 0x202F ||
    code === 0x2028 || code === 0x2029 ||
    code === 0x2060 ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x3164 ||
    code === 0xFEFF;
  return invisible ? 'warning' : 'information';
}

function ingestList(raw: RawList, origin: string, target: RuleSet): void {
  const name = typeof raw.name === 'string' ? raw.name : origin;
  let charCount = 0;
  let phraseCount = 0;

  if (Array.isArray(raw.chars)) {
    for (const c of raw.chars as RawCharRule[]) {
      if (typeof c.char !== 'string' || c.char.length === 0) continue;
      const charStr = c.char;
      target.chars.set(charStr, {
        char: charStr,
        name: typeof c.name === 'string'
          ? c.name
          : `Unknown char (U+${charStr.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`,
        severity: parseSeverity(c.severity, defaultCharSeverity(charStr)),
        replacement: typeof c.replacement === 'string' ? c.replacement : undefined,
        suggestion: typeof c.suggestion === 'string' ? c.suggestion : undefined,
        source: name,
      });
      charCount++;
    }
  }

  if (Array.isArray(raw.phrases)) {
    for (const p of raw.phrases as RawPhraseRule[]) {
      if (typeof p.pattern !== 'string' || p.pattern.length === 0) continue;
      let regex: RegExp;
      try {
        regex = new RegExp(p.pattern, 'gi');
      } catch (e) {
        console.warn(`[LLM Slop] Invalid regex in ${origin}: ${p.pattern}`, e);
        continue;
      }
      target.phrases.push({
        pattern: p.pattern,
        regex,
        reason: typeof p.reason === 'string' ? p.reason : undefined,
        severity: parseSeverity(p.severity, 'information'),
        source: name,
      });
      phraseCount++;
    }
  }

  target.sources.push({
    name,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    origin,
    charCount,
    phraseCount,
  });
}

function buildCharRegex(chars: Map<string, CharRule>): RegExp {
  if (chars.size === 0) return /(?!)/g;
  const body = Array.from(chars.keys())
    .map(c => '\\u{' + c.codePointAt(0)!.toString(16) + '}')
    .join('');
  return new RegExp('[' + body + ']', 'gu');
}

function charCodepointSelector(char: string): string {
  return `char:U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

// Normalize `char:u+2014` / `char:U+2014` / `char:U+02014` to a single canonical
// key so lookups don't depend on user casing or zero-padding. Literal char keys
// (`char:--`) and non-char selectors pass through unchanged.
function normalizeOverrideKey(key: string): string {
  if (!key.startsWith('char:')) return key;
  const rest = key.slice(5);
  const m = /^[uU]\+([0-9a-fA-F]+)$/.exec(rest);
  if (!m) return key;
  const cp = parseInt(m[1], 16);
  if (Number.isNaN(cp)) return key;
  return `char:U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function parseSeverityOverrideValue(v: unknown): SeverityOverride | null {
  if (v === 'off') return 'off';
  if (v === 'error' || v === 'warning' || v === 'hint') return v;
  if (v === 'information' || v === 'info') return 'information';
  return null;
}

// Canonicalize user-provided override map: normalize char selector keys and
// validate/coerce values. Invalid values are dropped with a console warning.
export function parseSeverityOverrides(raw: Record<string, unknown> | undefined | null): Record<string, SeverityOverride> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, SeverityOverride> = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parseSeverityOverrideValue(value);
    if (parsed === null) {
      console.warn(`[LLM Slop] invalid severity in severityOverrides for "${key}": ${String(value)}`);
      continue;
    }
    out[normalizeOverrideKey(key)] = parsed;
  }
  return out;
}

function resolveCharOverride(
  rule: CharRule,
  overrides: Record<string, SeverityOverride>,
): SeverityOverride | undefined {
  // Most specific: rule-level. Literal first so `char:--: hint` beats
  // `char:U+2014: off` when both are present.
  const literal = `char:${rule.char}`;
  if (literal in overrides) return overrides[literal];
  const cp = charCodepointSelector(rule.char);
  if (cp in overrides) return overrides[cp];
  // Pack-level (source is `pack:<name>` for built-in packs).
  if (rule.source.startsWith('pack:') && rule.source in overrides) return overrides[rule.source];
  // Source-level.
  const src = `source:${rule.source}`;
  if (src in overrides) return overrides[src];
  return undefined;
}

function resolvePhraseOverride(
  rule: PhraseRule,
  overrides: Record<string, SeverityOverride>,
): SeverityOverride | undefined {
  const phraseKey = `phrase:${rule.pattern}`;
  if (phraseKey in overrides) return overrides[phraseKey];
  if (rule.source.startsWith('pack:') && rule.source in overrides) return overrides[rule.source];
  const src = `source:${rule.source}`;
  if (src in overrides) return overrides[src];
  return undefined;
}

function applySeverityOverrides(
  rules: RuleSet,
  overrides: Record<string, SeverityOverride>,
): void {
  if (Object.keys(overrides).length === 0) return;

  let applied = 0;

  const charsToDelete: string[] = [];
  for (const [char, rule] of rules.chars) {
    const ov = resolveCharOverride(rule, overrides);
    if (ov === undefined) continue;
    applied++;
    if (ov === 'off') charsToDelete.push(char);
    else rules.chars.set(char, { ...rule, severity: ov });
  }
  for (const c of charsToDelete) rules.chars.delete(c);

  const remainingPhrases: PhraseRule[] = [];
  for (const phrase of rules.phrases) {
    const ov = resolvePhraseOverride(phrase, overrides);
    if (ov === undefined) {
      remainingPhrases.push(phrase);
      continue;
    }
    applied++;
    if (ov === 'off') continue;
    remainingPhrases.push({ ...phrase, severity: ov });
  }
  rules.phrases = remainingPhrases;

  // Recompute per-source counts so the rule-sources quick pick reflects
  // effective rule counts rather than raw ingest counts.
  const countBySource = new Map<string, { chars: number; phrases: number }>();
  const bump = (name: string, kind: 'chars' | 'phrases') => {
    const entry = countBySource.get(name) ?? { chars: 0, phrases: 0 };
    entry[kind]++;
    countBySource.set(name, entry);
  };
  for (const r of rules.chars.values()) bump(r.source, 'chars');
  for (const r of rules.phrases) bump(r.source, 'phrases');
  for (const src of rules.sources) {
    const c = countBySource.get(src.name);
    src.charCount = c?.chars ?? 0;
    src.phraseCount = c?.phrases ?? 0;
  }

  rules.overridesApplied = applied;
}

export function loadRules(opts: LoadOptions): RuleSet {
  const rules: RuleSet = {
    chars: new Map(),
    phrases: [],
    sources: [],
    charRegex: /(?!)/g,
    overridesApplied: 0,
  };

  for (const { origin, raw } of opts.lists) {
    ingestList(raw, origin, rules);
  }

  if (opts.userPhrases.length > 0) {
    ingestList(
      { name: 'user settings', phrases: opts.userPhrases.map(pattern => ({ pattern })) },
      'settings.json',
      rules
    );
  }

  for (const [char, replacement] of Object.entries(opts.charReplacements)) {
    const existing = rules.chars.get(char);
    if (existing) {
      rules.chars.set(char, {
        ...existing,
        replacement,
        source: `${existing.source} + settings`,
      });
    } else {
      rules.chars.set(char, {
        char,
        name: `User-defined (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`,
        severity: defaultCharSeverity(char),
        replacement,
        source: 'settings.json',
      });
    }
  }

  applySeverityOverrides(rules, opts.severityOverrides);

  rules.charRegex = buildCharRegex(rules.chars);
  return rules;
}

import * as fs from 'fs';
import * as path from 'path';
import { CharRule, RuleSet, Severity } from './types';

export const LOCAL_RULES_FILENAME = '.llmsloprc.json';

export const BUILTIN_PACKS = ['academic', 'cliches', 'fiction', 'claudeisms', 'structural', 'security'] as const;
export type BuiltinPack = typeof BUILTIN_PACKS[number];

export type LoadOptions = {
  extensionRoot: string;
  useBuiltin: boolean;
  enabledPacks: string[];
  localRulePaths: string[];
  userPhrases: string[];
  charReplacements: Record<string, string>;
};

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

type RawList = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  chars?: unknown;
  phrases?: unknown;
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

function readJsonFile(p: string): RawList | null {
  try {
    const text = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) return parsed as RawList;
    console.warn(`[LLM Slop] ${p} is not a JSON object`);
    return null;
  } catch (e) {
    console.warn(`[LLM Slop] Failed to read ${p}:`, e);
    return null;
  }
}

function buildCharRegex(chars: Map<string, CharRule>): RegExp {
  if (chars.size === 0) return /(?!)/g;
  const body = Array.from(chars.keys())
    .map(c => '\\u{' + c.codePointAt(0)!.toString(16) + '}')
    .join('');
  return new RegExp('[' + body + ']', 'gu');
}

export function loadRules(opts: LoadOptions): RuleSet {
  const rules: RuleSet = {
    chars: new Map(),
    phrases: [],
    sources: [],
    charRegex: /(?!)/g,
  };

  if (opts.useBuiltin) {
    const builtinPath = path.join(opts.extensionRoot, 'builtin-rules.json');
    const raw = readJsonFile(builtinPath);
    if (raw) ingestList(raw, 'built-in', rules);
  }

  const allowed = new Set<string>(BUILTIN_PACKS);
  for (const pack of opts.enabledPacks) {
    if (!allowed.has(pack)) continue;
    const packPath = path.join(opts.extensionRoot, 'builtin-packs', `${pack}.json`);
    const raw = readJsonFile(packPath);
    if (raw) ingestList(raw, `pack:${pack}`, rules);
  }

  for (const p of opts.localRulePaths) {
    const raw = readJsonFile(p);
    if (raw) ingestList(raw, p, rules);
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

  rules.charRegex = buildCharRegex(rules.chars);
  return rules;
}

export function findLocalRulePathFromCwd(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, LOCAL_RULES_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export const LOCAL_RULES_FILENAME = '.llmsloprc.json';

export const BUILTIN_PACKS = ['academic', 'cliches', 'fiction', 'claudeisms', 'structural'] as const;
export type BuiltinPack = typeof BUILTIN_PACKS[number];

export type CharRule = {
  char: string;
  name: string;
  severity: vscode.DiagnosticSeverity;
  replacement?: string;
  suggestion?: string;
  source: string;
};

export type PhraseRule = {
  pattern: string;
  regex: RegExp;
  reason?: string;
  severity: vscode.DiagnosticSeverity;
  source: string;
};

export type RuleSource = {
  name: string;
  version?: string;
  description?: string;
  origin: string;
  charCount: number;
  phraseCount: number;
};

export type RuleSet = {
  chars: Map<string, CharRule>;
  phrases: PhraseRule[];
  sources: RuleSource[];
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

function parseSeverity(s: unknown, fallback: vscode.DiagnosticSeverity): vscode.DiagnosticSeverity {
  switch (s) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'information':
    case 'info': return vscode.DiagnosticSeverity.Information;
    case 'hint': return vscode.DiagnosticSeverity.Hint;
    default: return fallback;
  }
}

// Chars in the invisible/zero-width ranges are dangerous (hide in text,
// break diffs, enable Trojan Source attacks); visible punctuation is merely suspicious.
function defaultCharSeverity(char: string): vscode.DiagnosticSeverity {
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
  return invisible ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
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
        severity: parseSeverity(p.severity, vscode.DiagnosticSeverity.Information),
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

export function getLocalRulePaths(): string[] {
  const paths: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const p = path.join(folder.uri.fsPath, LOCAL_RULES_FILENAME);
    if (fs.existsSync(p)) paths.push(p);
  }
  return paths;
}

export function loadRules(extensionUri: vscode.Uri): RuleSet {
  const rules: RuleSet = {
    chars: new Map(),
    phrases: [],
    sources: [],
  };
  const cfg = vscode.workspace.getConfiguration('llmSlopDetector');

  // 1. Built-in rules shipped with the extension.
  if (cfg.get<boolean>('useBuiltinRules', true)) {
    const builtinPath = vscode.Uri.joinPath(extensionUri, 'builtin-rules.json').fsPath;
    const raw = readJsonFile(builtinPath);
    if (raw) ingestList(raw, 'built-in', rules);
  }

  // 1b. Optional built-in packs the user opts into.
  const enabledPacks = cfg.get<string[]>('enabledPacks', []);
  const allowed = new Set<string>(BUILTIN_PACKS);
  for (const pack of enabledPacks) {
    if (!allowed.has(pack)) continue;
    const packPath = vscode.Uri.joinPath(extensionUri, 'builtin-packs', `${pack}.json`).fsPath;
    const raw = readJsonFile(packPath);
    if (raw) ingestList(raw, `pack:${pack}`, rules);
  }

  // 2. Local workspace rule files (.llmsloprc.json at workspace root).
  for (const p of getLocalRulePaths()) {
    const raw = readJsonFile(p);
    if (raw) ingestList(raw, p, rules);
  }

  // 3. User settings: simple additive layer for quick tweaks.
  const userPhrases = cfg.get<string[]>('phrases', []);
  if (userPhrases.length > 0) {
    ingestList(
      { name: 'user settings', phrases: userPhrases.map(pattern => ({ pattern })) },
      'settings.json',
      rules
    );
  }
  const charOverrides = cfg.get<Record<string, string>>('charReplacements', {});
  for (const [char, replacement] of Object.entries(charOverrides)) {
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

  return rules;
}

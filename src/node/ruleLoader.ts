import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_PACKS,
  LOCAL_RULES_FILENAME,
  LoadOptions as CoreLoadOptions,
  RawList,
  loadRules as coreLoadRules,
} from '../core/rules';
import { RuleSet, SeverityOverride } from '../core/types';

export type LoadOptions = {
  extensionRoot: string;
  useBuiltin: boolean;
  enabledPacks: string[];
  localRulePaths: string[];
  userPhrases: string[];
  charReplacements: Record<string, string>;
  severityOverrides: Record<string, SeverityOverride>;
};

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

export function loadRules(opts: LoadOptions): RuleSet {
  const lists: CoreLoadOptions['lists'] = [];

  if (opts.useBuiltin) {
    const builtinPath = path.join(opts.extensionRoot, 'builtin-rules.json');
    const raw = readJsonFile(builtinPath);
    if (raw) lists.push({ origin: 'built-in', raw });
  }

  const allowed = new Set<string>(BUILTIN_PACKS);
  for (const pack of opts.enabledPacks) {
    if (!allowed.has(pack)) continue;
    const packPath = path.join(opts.extensionRoot, 'builtin-packs', `${pack}.json`);
    const raw = readJsonFile(packPath);
    if (raw) lists.push({ origin: `pack:${pack}`, raw });
  }

  for (const p of opts.localRulePaths) {
    const raw = readJsonFile(p);
    if (raw) lists.push({ origin: p, raw });
  }

  return coreLoadRules({
    lists,
    userPhrases: opts.userPhrases,
    charReplacements: opts.charReplacements,
    severityOverrides: opts.severityOverrides,
  });
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

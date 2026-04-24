import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_PACKS, LOCAL_RULES_FILENAME, parseSeverityOverrides } from './core/rules';
import { loadRules as coreLoadRules } from './node/ruleLoader';
import { RuleSet, Severity } from './core/types';

export { LOCAL_RULES_FILENAME, BUILTIN_PACKS };
export type { RuleSet, CharRule, PhraseRule, RuleSource } from './core/types';

export function severityToVscode(s: Severity): vscode.DiagnosticSeverity {
  switch (s) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'information': return vscode.DiagnosticSeverity.Information;
    case 'hint': return vscode.DiagnosticSeverity.Hint;
  }
}

function getLocalRulePaths(): string[] {
  // Workspace rule files ship arbitrary regex. In an untrusted workspace we
  // fall back to built-in rules only; a catastrophic-backtracking pattern in
  // a random repo shouldn't be able to wedge the extension host.
  if (!vscode.workspace.isTrusted) return [];
  const paths: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const p = path.join(folder.uri.fsPath, LOCAL_RULES_FILENAME);
    if (fs.existsSync(p)) paths.push(p);
  }
  return paths;
}

export function loadRules(extensionUri: vscode.Uri): RuleSet {
  const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
  return coreLoadRules({
    extensionRoot: extensionUri.fsPath,
    useBuiltin: cfg.get<boolean>('useBuiltinRules', true),
    enabledPacks: cfg.get<string[]>('enabledPacks', []),
    localRulePaths: getLocalRulePaths(),
    userPhrases: cfg.get<string[]>('phrases', []),
    charReplacements: cfg.get<Record<string, string>>('charReplacements', {}),
    severityOverrides: parseSeverityOverrides(cfg.get<Record<string, unknown>>('severityOverrides', {})),
  });
}

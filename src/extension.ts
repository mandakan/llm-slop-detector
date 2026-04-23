import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Character definitions
// ---------------------------------------------------------------------------

type CharDef = {
  char: string;
  name: string;
  severity: vscode.DiagnosticSeverity;
  // Built-in safe replacement. Undefined = no auto-fix by default
  // (user can still opt in via llmSlopDetector.charReplacements).
  defaultReplacement?: string;
  // Freeform guidance shown in the diagnostic when there is no default
  // replacement — explains why we're not offering one.
  suggestion?: string;
};

// Invisible / zero-width — these are the most dangerous, always warn.
const INVISIBLES: CharDef[] = [
  { char: '​', name: 'ZERO WIDTH SPACE (U+200B)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: '' },
  { char: '‌', name: 'ZERO WIDTH NON-JOINER (U+200C)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: '' },
  { char: '‍', name: 'ZERO WIDTH JOINER (U+200D)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: '' },
  { char: '⁠', name: 'WORD JOINER (U+2060)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: '' },
  { char: '﻿', name: 'ZERO WIDTH NO-BREAK SPACE / BOM (U+FEFF)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: '' },
  { char: ' ', name: 'NO-BREAK SPACE (U+00A0)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: ' ' },
  { char: ' ', name: 'NARROW NO-BREAK SPACE (U+202F)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: ' ' },
  { char: ' ', name: 'LINE SEPARATOR (U+2028)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: '\n' },
  { char: ' ', name: 'PARAGRAPH SEPARATOR (U+2029)', severity: vscode.DiagnosticSeverity.Warning, defaultReplacement: '\n' },
];

// Visible but suspicious — classic LLM punctuation. Info-level (blue), not noisy.
// Angle quotes, primes, and middle dot have no default fix: they're legitimate
// punctuation in many contexts (French/German quotes, measurements, Catalan).
const SUSPICIOUS: CharDef[] = [
  { char: '—', name: 'EM DASH (U+2014)', severity: vscode.DiagnosticSeverity.Information, defaultReplacement: '-' },
  { char: '–', name: 'EN DASH (U+2013)', severity: vscode.DiagnosticSeverity.Information, defaultReplacement: '-' },
  { char: '…', name: 'HORIZONTAL ELLIPSIS (U+2026)', severity: vscode.DiagnosticSeverity.Information, defaultReplacement: '...' },
  { char: '“', name: 'LEFT DOUBLE QUOTATION MARK (U+201C)', severity: vscode.DiagnosticSeverity.Information, defaultReplacement: '"' },
  { char: '”', name: 'RIGHT DOUBLE QUOTATION MARK (U+201D)', severity: vscode.DiagnosticSeverity.Information, defaultReplacement: '"' },
  { char: '‘', name: 'LEFT SINGLE QUOTATION MARK (U+2018)', severity: vscode.DiagnosticSeverity.Information, defaultReplacement: "'" },
  { char: '’', name: 'RIGHT SINGLE QUOTATION MARK (U+2019)', severity: vscode.DiagnosticSeverity.Information, defaultReplacement: "'" },
  { char: '«', name: 'LEFT-POINTING DOUBLE ANGLE QUOTATION MARK (U+00AB)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'often legitimate in French/German — no default fix' },
  { char: '»', name: 'RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK (U+00BB)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'often legitimate in French/German — no default fix' },
  { char: '′', name: 'PRIME (U+2032)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'used in measurements (5′10″) — no default fix' },
  { char: '″', name: 'DOUBLE PRIME (U+2033)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'used in measurements (5′10″) — no default fix' },
  { char: '·', name: 'MIDDLE DOT (U+00B7)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'legitimate in Catalan and list separators — no default fix' },
];

const ALL_CHARS = [...INVISIBLES, ...SUSPICIOUS];

// Build one regex that matches any flagged char for fast scanning.
const CHAR_REGEX = new RegExp(
  '[' + ALL_CHARS.map(c => '\\u' + c.char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + ']',
  'g'
);
const CHAR_LOOKUP = new Map(ALL_CHARS.map(c => [c.char, c]));

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const SOURCE = 'LLM Slop';

function buildPhraseRegexes(): RegExp[] {
  const patterns = vscode.workspace
    .getConfiguration('llmSlopDetector')
    .get<string[]>('phrases', []);
  const regexes: RegExp[] = [];
  for (const p of patterns) {
    try {
      regexes.push(new RegExp(p, 'gi'));
    } catch (e) {
      // Skip invalid patterns, don't crash the extension.
      console.warn(`[LLM Slop] Invalid regex skipped: ${p}`, e);
    }
  }
  return regexes;
}

// Resolve the effective replacement for a char: user override wins over default.
// Returns undefined if no replacement is configured (no auto-fix offered).
function getReplacement(char: string): string | undefined {
  const overrides = vscode.workspace
    .getConfiguration('llmSlopDetector')
    .get<Record<string, string>>('charReplacements', {});
  if (Object.prototype.hasOwnProperty.call(overrides, char)) {
    return overrides[char];
  }
  return CHAR_LOOKUP.get(char)?.defaultReplacement;
}

function diagnosticMessage(def: CharDef): string {
  const replacement = getReplacement(def.char);
  if (replacement !== undefined) {
    const shown = replacement === '' ? 'delete' :
      replacement === '\n' ? 'newline' :
      replacement === ' ' ? 'regular space' :
      JSON.stringify(replacement);
    return `${def.name} — fix: ${shown}`;
  }
  return def.suggestion ? `${def.name} — ${def.suggestion}` : def.name;
}

function scanDocument(doc: vscode.TextDocument, phraseRegexes: RegExp[]): vscode.Diagnostic[] {
  const diags: vscode.Diagnostic[] = [];
  const text = doc.getText();

  // 1. Character-level scan.
  CHAR_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHAR_REGEX.exec(text)) !== null) {
    const def = CHAR_LOOKUP.get(m[0]);
    if (!def) continue;
    const start = doc.positionAt(m.index);
    const end = doc.positionAt(m.index + m[0].length);
    const d = new vscode.Diagnostic(new vscode.Range(start, end), diagnosticMessage(def), def.severity);
    d.source = SOURCE;
    d.code = 'char';
    diags.push(d);
  }

  // 2. Phrase-level scan (Information severity only — less noisy).
  for (const rx of phraseRegexes) {
    rx.lastIndex = 0;
    while ((m = rx.exec(text)) !== null) {
      if (m[0].length === 0) {
        rx.lastIndex++;
        continue;
      }
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      const d = new vscode.Diagnostic(
        new vscode.Range(start, end),
        `LLM-style phrase: "${m[0]}"`,
        vscode.DiagnosticSeverity.Information
      );
      d.source = SOURCE;
      d.code = 'phrase';
      diags.push(d);
    }
  }

  return diags;
}

// ---------------------------------------------------------------------------
// Code actions (quick fixes)
// ---------------------------------------------------------------------------

class SlopCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Per-diagnostic quick fixes for the selection/cursor range.
    for (const diag of context.diagnostics) {
      if (diag.source !== SOURCE || diag.code !== 'char') continue;
      const char = document.getText(diag.range);
      const replacement = getReplacement(char);
      if (replacement === undefined) continue;

      const def = CHAR_LOOKUP.get(char);
      const title = replacement === ''
        ? `Delete ${def?.name ?? 'character'}`
        : replacement === '\n'
          ? `Replace ${def?.name ?? 'character'} with newline`
          : `Replace ${def?.name ?? 'character'} with ${JSON.stringify(replacement)}`;

      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, diag.range, replacement);
      action.diagnostics = [diag];
      action.isPreferred = true;
      actions.push(action);
    }

    // Fix-all-in-file action. Only offered when the cursor's current diagnostic
    // context contains at least one fixable char — otherwise the lightbulb
    // would suggest it on phrase diagnostics where no char fix applies.
    const contextHasFixableChar = context.diagnostics.some(d =>
      d.source === SOURCE && d.code === 'char' &&
      getReplacement(document.getText(d.range)) !== undefined
    );
    const allDiags = vscode.languages.getDiagnostics(document.uri)
      .filter(d => d.source === SOURCE && d.code === 'char');
    const fixable = allDiags.filter(d => {
      const c = document.getText(d.range);
      return getReplacement(c) !== undefined;
    });
    if (contextHasFixableChar && fixable.length > 0) {
      const fixAll = new vscode.CodeAction(
        `Fix all LLM slop characters in file (${fixable.length})`,
        vscode.CodeActionKind.QuickFix
      );
      fixAll.edit = new vscode.WorkspaceEdit();
      for (const d of fixable) {
        const c = document.getText(d.range);
        const r = getReplacement(c);
        if (r !== undefined) fixAll.edit.replace(document.uri, d.range, r);
      }
      fixAll.diagnostics = fixable;
      actions.push(fixAll);
    }

    return actions;
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

const SUPPORTED_LANGS = new Set(['markdown', 'plaintext']);
const CODE_ACTION_SELECTORS: vscode.DocumentSelector = [
  { language: 'markdown' },
  { language: 'plaintext' },
];

export function activate(context: vscode.ExtensionContext) {
  const collection = vscode.languages.createDiagnosticCollection('llmSlopDetector');
  context.subscriptions.push(collection);

  let phraseRegexes = buildPhraseRegexes();

  const refresh = (doc: vscode.TextDocument) => {
    const enabled = vscode.workspace.getConfiguration('llmSlopDetector').get<boolean>('enabled', true);
    if (!enabled || !SUPPORTED_LANGS.has(doc.languageId)) {
      collection.delete(doc.uri);
      return;
    }
    collection.set(doc.uri, scanDocument(doc, phraseRegexes));
  };

  // Scan already-open documents on activation.
  vscode.workspace.textDocuments.forEach(refresh);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument(e => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('llmSlopDetector')) {
        phraseRegexes = buildPhraseRegexes();
        vscode.workspace.textDocuments.forEach(refresh);
      }
    }),
    vscode.languages.registerCodeActionsProvider(
      CODE_ACTION_SELECTORS,
      new SlopCodeActionProvider(),
      { providedCodeActionKinds: SlopCodeActionProvider.providedCodeActionKinds }
    ),
    vscode.commands.registerCommand('llmSlopDetector.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
      const current = cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`LLM Slop Detector ${!current ? 'enabled' : 'disabled'}`);
    })
  );
}

export function deactivate() { /* diagnostics are disposed via subscriptions */ }

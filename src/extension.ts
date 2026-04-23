import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Character definitions
// ---------------------------------------------------------------------------

type CharDef = {
  char: string;
  name: string;
  severity: vscode.DiagnosticSeverity;
  suggestion?: string;
};

// Invisible / zero-width — these are the most dangerous, always warn.
const INVISIBLES: CharDef[] = [
  { char: '\u200B', name: 'ZERO WIDTH SPACE (U+200B)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'delete' },
  { char: '\u200C', name: 'ZERO WIDTH NON-JOINER (U+200C)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'delete' },
  { char: '\u200D', name: 'ZERO WIDTH JOINER (U+200D)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'delete' },
  { char: '\u2060', name: 'WORD JOINER (U+2060)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'delete' },
  { char: '\uFEFF', name: 'ZERO WIDTH NO-BREAK SPACE / BOM (U+FEFF)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'delete' },
  { char: '\u00A0', name: 'NO-BREAK SPACE (U+00A0)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'replace with regular space' },
  { char: '\u202F', name: 'NARROW NO-BREAK SPACE (U+202F)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'replace with regular space' },
  { char: '\u2028', name: 'LINE SEPARATOR (U+2028)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'replace with newline' },
  { char: '\u2029', name: 'PARAGRAPH SEPARATOR (U+2029)', severity: vscode.DiagnosticSeverity.Warning, suggestion: 'replace with newline' },
];

// Visible but suspicious — classic LLM punctuation. Info-level (blue), not noisy.
const SUSPICIOUS: CharDef[] = [
  { char: '\u2014', name: 'EM DASH (U+2014)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'consider " - " or rewrite' },
  { char: '\u2013', name: 'EN DASH (U+2013)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'consider "-" or rewrite' },
  { char: '\u2026', name: 'HORIZONTAL ELLIPSIS (U+2026)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'replace with "..."' },
  { char: '\u201C', name: 'LEFT DOUBLE QUOTATION MARK (U+201C)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'replace with "' },
  { char: '\u201D', name: 'RIGHT DOUBLE QUOTATION MARK (U+201D)', severity: vscode.DiagnosticSeverity.Information, suggestion: 'replace with "' },
  { char: '\u2018', name: 'LEFT SINGLE QUOTATION MARK (U+2018)', severity: vscode.DiagnosticSeverity.Information, suggestion: "replace with '" },
  { char: '\u2019', name: 'RIGHT SINGLE QUOTATION MARK (U+2019)', severity: vscode.DiagnosticSeverity.Information, suggestion: "replace with '" },
  { char: '\u00AB', name: 'LEFT-POINTING DOUBLE ANGLE QUOTATION MARK (U+00AB)', severity: vscode.DiagnosticSeverity.Information },
  { char: '\u00BB', name: 'RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK (U+00BB)', severity: vscode.DiagnosticSeverity.Information },
  { char: '\u2032', name: 'PRIME (U+2032)', severity: vscode.DiagnosticSeverity.Information },
  { char: '\u2033', name: 'DOUBLE PRIME (U+2033)', severity: vscode.DiagnosticSeverity.Information },
  { char: '\u00B7', name: 'MIDDLE DOT (U+00B7)', severity: vscode.DiagnosticSeverity.Information },
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
    const msg = def.suggestion
      ? `${def.name} — ${def.suggestion}`
      : def.name;
    const d = new vscode.Diagnostic(new vscode.Range(start, end), msg, def.severity);
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
// Activation
// ---------------------------------------------------------------------------

const SUPPORTED_LANGS = new Set(['markdown', 'plaintext']);

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
    vscode.commands.registerCommand('llmSlopDetector.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
      const current = cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`LLM Slop Detector ${!current ? 'enabled' : 'disabled'}`);
    })
  );
}

export function deactivate() { /* diagnostics are disposed via subscriptions */ }

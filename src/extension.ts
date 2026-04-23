import * as vscode from 'vscode';
import { CharRule, LOCAL_RULES_FILENAME, RuleSet, loadRules } from './rules';

const SOURCE = 'LLM Slop';
const SUPPORTED_LANGS = new Set(['markdown', 'plaintext']);
const CODE_ACTION_SELECTORS: vscode.DocumentSelector = [
  { language: 'markdown' },
  { language: 'plaintext' },
];

// Module-level mutable rule state. Rebuilt on config change / rule-file change
// and scans read through it.
let RULES: RuleSet = { chars: new Map(), phrases: [], sources: [] };
let CHAR_REGEX: RegExp = /(?!)/g;

function rebuildCharRegex() {
  if (RULES.chars.size === 0) {
    CHAR_REGEX = /(?!)/g;
    return;
  }
  const body = Array.from(RULES.chars.keys())
    .map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('');
  CHAR_REGEX = new RegExp('[' + body + ']', 'g');
}

function getReplacement(char: string): string | undefined {
  return RULES.chars.get(char)?.replacement;
}

function charDiagnosticMessage(def: CharRule): string {
  const parts = [def.name];
  if (def.replacement !== undefined) {
    const shown =
      def.replacement === '' ? 'delete' :
      def.replacement === '\n' ? 'newline' :
      def.replacement === ' ' ? 'regular space' :
      JSON.stringify(def.replacement);
    parts.push(`fix: ${shown}`);
  } else if (def.suggestion) {
    parts.push(def.suggestion);
  }
  return `${parts.join(' - ')} [${def.source}]`;
}

function scanDocument(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const diags: vscode.Diagnostic[] = [];
  const text = doc.getText();

  // Characters.
  CHAR_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHAR_REGEX.exec(text)) !== null) {
    const def = RULES.chars.get(m[0]);
    if (!def) continue;
    const start = doc.positionAt(m.index);
    const end = doc.positionAt(m.index + m[0].length);
    const d = new vscode.Diagnostic(new vscode.Range(start, end), charDiagnosticMessage(def), def.severity);
    d.source = SOURCE;
    d.code = 'char';
    diags.push(d);
  }

  // Phrases.
  for (const p of RULES.phrases) {
    p.regex.lastIndex = 0;
    while ((m = p.regex.exec(text)) !== null) {
      if (m[0].length === 0) { p.regex.lastIndex++; continue; }
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      const reasonBit = p.reason ? ` - ${p.reason}` : '';
      const d = new vscode.Diagnostic(
        new vscode.Range(start, end),
        `LLM-style phrase: "${m[0]}"${reasonBit} [${p.source}]`,
        p.severity
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
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diag of context.diagnostics) {
      if (diag.source !== SOURCE || diag.code !== 'char') continue;
      const char = document.getText(diag.range);
      const replacement = getReplacement(char);
      if (replacement === undefined) continue;

      const def = RULES.chars.get(char);
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

    const contextHasFixableChar = context.diagnostics.some(d =>
      d.source === SOURCE && d.code === 'char' &&
      getReplacement(document.getText(d.range)) !== undefined
    );
    const fixable = vscode.languages.getDiagnostics(document.uri)
      .filter(d => d.source === SOURCE && d.code === 'char')
      .filter(d => getReplacement(document.getText(d.range)) !== undefined);
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

export function activate(context: vscode.ExtensionContext) {
  const collection = vscode.languages.createDiagnosticCollection('llmSlopDetector');
  context.subscriptions.push(collection);

  const refresh = (doc: vscode.TextDocument) => {
    const enabled = vscode.workspace.getConfiguration('llmSlopDetector').get<boolean>('enabled', true);
    if (!enabled || !SUPPORTED_LANGS.has(doc.languageId)) {
      collection.delete(doc.uri);
      return;
    }
    collection.set(doc.uri, scanDocument(doc));
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'llmSlopDetector.toggle';
  context.subscriptions.push(status);

  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !SUPPORTED_LANGS.has(editor.document.languageId)) {
      status.hide();
      return;
    }
    const enabled = vscode.workspace.getConfiguration('llmSlopDetector').get<boolean>('enabled', true);
    if (!enabled) {
      status.text = '$(circle-slash) Slop off';
      status.tooltip = 'LLM Slop Detector is disabled. Click to enable.';
      status.backgroundColor = undefined;
      status.show();
      return;
    }
    const diags = vscode.languages.getDiagnostics(editor.document.uri)
      .filter(d => d.source === SOURCE);
    const chars = diags.filter(d => d.code === 'char').length;
    const phrases = diags.filter(d => d.code === 'phrase').length;
    const total = chars + phrases;
    if (total === 0) {
      status.text = '$(check) No slop';
      status.tooltip = 'LLM Slop Detector: no issues in this file. Click to disable.';
      status.backgroundColor = undefined;
    } else {
      status.text = `$(warning) ${total} slop`;
      const charPart = `${chars} character${chars === 1 ? '' : 's'}`;
      const phrasePart = `${phrases} phrase${phrases === 1 ? '' : 's'}`;
      status.tooltip = `LLM Slop Detector: ${charPart}, ${phrasePart}. Click to disable.`;
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    status.show();
  };

  const reloadRules = () => {
    RULES = loadRules(context.extensionUri);
    rebuildCharRegex();
    vscode.workspace.textDocuments.forEach(refresh);
    updateStatus();
  };

  reloadRules();

  // Live-reload when a local .llmsloprc.json is created/changed/deleted
  // anywhere in the workspace. The loader itself only reads the files at
  // workspace roots; nested matches just trigger a harmless reload.
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${LOCAL_RULES_FILENAME}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(reloadRules),
    watcher.onDidCreate(reloadRules),
    watcher.onDidDelete(reloadRules),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => { refresh(doc); updateStatus(); }),
    vscode.workspace.onDidChangeTextDocument(e => { refresh(e.document); updateStatus(); }),
    vscode.workspace.onDidCloseTextDocument(doc => { collection.delete(doc.uri); updateStatus(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(reloadRules),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus()),
    vscode.languages.onDidChangeDiagnostics(() => updateStatus()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('llmSlopDetector')) reloadRules();
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
    }),
    vscode.commands.registerCommand('llmSlopDetector.showOnboarding', () => showOnboarding(context)),
    vscode.commands.registerCommand('llmSlopDetector.showRuleSources', async () => {
      if (RULES.sources.length === 0) {
        vscode.window.showInformationMessage('LLM Slop Detector: no rule sources loaded.');
        return;
      }
      const items = RULES.sources.map(s => ({
        label: `$(list-unordered) ${s.name}${s.version ? ` v${s.version}` : ''}`,
        description: `${s.charCount} char${s.charCount === 1 ? '' : 's'}, ${s.phraseCount} phrase${s.phraseCount === 1 ? '' : 's'}`,
        detail: s.description ? `${s.description} (${s.origin})` : s.origin,
      }));
      await vscode.window.showQuickPick(items, { title: 'LLM Slop Detector: loaded rule sources' });
    })
  );

  void maybeShowOnboarding(context);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

// Versioned so we can re-trigger onboarding for material UX changes without
// spamming users who have already seen the current version. Bump the suffix
// when you want everyone to see the toast again.
const ONBOARDING_KEY = 'llmSlopDetector.onboarding.v1';

async function maybeShowOnboarding(context: vscode.ExtensionContext) {
  if (context.globalState.get<boolean>(ONBOARDING_KEY, false)) return;
  await showOnboarding(context);
}

async function showOnboarding(context: vscode.ExtensionContext) {
  const openPacks = 'Browse rule packs';
  const learnMore = 'Learn more';
  const dismiss = 'Dismiss';

  const choice = await vscode.window.showInformationMessage(
    'LLM Slop Detector is watching Markdown and plain-text files. Optional rule packs (academic, fiction, claudeisms, structural) add broader coverage -- opt into them in settings.',
    openPacks,
    learnMore,
    dismiss,
  );

  // Record as shown regardless of choice. Any interaction -- including
  // dismissal via the X button -- suppresses the toast on future activations.
  await context.globalState.update(ONBOARDING_KEY, true);

  if (choice === openPacks) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'llmSlopDetector.enabledPacks');
  } else if (choice === learnMore) {
    await vscode.commands.executeCommand('extension.open', context.extension.id);
  }
}

export function deactivate() { /* diagnostics are disposed via subscriptions */ }

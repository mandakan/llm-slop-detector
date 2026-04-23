import * as vscode from 'vscode';
import { LOCAL_RULES_FILENAME, RuleSet, loadRules, severityToVscode } from './rules';
import { Language, scanText } from './core/scan';
import { SUPPORTED_CODE_LANGUAGES } from './core/comments';

const SOURCE = 'LLM Slop';
const DOCS_URI = vscode.Uri.parse('https://github.com/mandakan/llm-slop-detector#what-it-flags');
const BASE_LANGS: Language[] = ['markdown', 'plaintext'];
let SUPPORTED_LANGS = new Set<Language>(BASE_LANGS);
const CODE_ACTION_SELECTORS: vscode.DocumentSelector = [{ scheme: 'file' }, { scheme: 'untitled' }];

function rebuildSupportedLangs() {
  const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
  const scanComments = cfg.get<boolean>('scanCodeComments', false);
  const codeLangs = cfg.get<string[]>('codeCommentLanguages', []);
  const allowed = new Set(SUPPORTED_CODE_LANGUAGES);
  SUPPORTED_LANGS = new Set<Language>([
    ...BASE_LANGS,
    ...(scanComments ? codeLangs.filter(l => allowed.has(l)) : []),
  ]);
}

// Module-level mutable rule state. Rebuilt on config change / rule-file change
// and scans read through it.
let RULES: RuleSet = { chars: new Map(), phrases: [], sources: [], charRegex: /(?!)/g };

function getReplacement(char: string): string | undefined {
  return RULES.chars.get(char)?.replacement;
}

function scanDocument(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const lang = doc.languageId as Language;
  if (!SUPPORTED_LANGS.has(lang)) return [];
  const findings = scanText(doc.getText(), RULES, lang);
  return findings.map(f => {
    const start = doc.positionAt(f.offset);
    const end = doc.positionAt(f.offset + f.length);
    const d = new vscode.Diagnostic(new vscode.Range(start, end), f.message, severityToVscode(f.severity));
    d.source = SOURCE;
    d.code = f.code;
    d.codeDescription = { href: DOCS_URI };
    return d;
  });
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
    if (!enabled || !SUPPORTED_LANGS.has(doc.languageId as Language)) {
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
    if (!editor || !SUPPORTED_LANGS.has(editor.document.languageId as Language)) {
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
    rebuildSupportedLangs();
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
    vscode.commands.registerCommand('llmSlopDetector.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id}`,
      );
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
    // Focus the specific setting the onboarding is selling. The general
    // "open all settings for this extension" entry point is the
    // llmSlopDetector.openSettings command.
    await vscode.commands.executeCommand('workbench.action.openSettings', 'llmSlopDetector.enabledPacks');
  } else if (choice === learnMore) {
    await vscode.commands.executeCommand('extension.open', context.extension.id);
  }
}

export function deactivate() { /* diagnostics are disposed via subscriptions */ }

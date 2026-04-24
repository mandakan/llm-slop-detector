import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { LOCAL_RULES_FILENAME, RuleSet, loadRules, severityToVscode } from './rules';
import { Language, offsetToLineCol, scanText } from './core/scan';
import { SUPPORTED_CODE_LANGUAGES } from './core/comments';
import { IgnoreMatcher, SLOPIGNORE_FILENAME, loadIgnoreMatcher } from './core/ignore';
import { Finding, Severity } from './core/types';

const SOURCE = 'LLM Slop';
const DOCS_URI = vscode.Uri.parse('https://github.com/mandakan/llm-slop-detector#what-it-flags');
const BASE_LANGS: Language[] = ['markdown', 'plaintext'];
let SUPPORTED_LANGS = new Set<Language>(BASE_LANGS);
const CODE_ACTION_SELECTORS: vscode.DocumentSelector = [{ scheme: 'file' }, { scheme: 'untitled' }];

// File-extension to language mapping for closed files. Mirrors the CLI; the
// extension uses VS Code's language IDs for open documents but needs an
// extension-based fallback for the workspace scan, which reads files off disk.
const PROSE_EXTENSIONS: ReadonlyMap<string, Language> = new Map([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.mdown', 'markdown'],
  ['.txt', 'plaintext'],
  ['.text', 'plaintext'],
]);

const CODE_EXTENSIONS: ReadonlyMap<string, Language> = new Map([
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.tsx', 'typescriptreact'],
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.jsx', 'javascriptreact'],
  ['.py', 'python'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.cs', 'csharp'],
  ['.cpp', 'cpp'], ['.cxx', 'cpp'], ['.cc', 'cpp'], ['.hpp', 'cpp'], ['.hxx', 'cpp'],
  ['.c', 'c'], ['.h', 'c'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
  ['.sh', 'shellscript'], ['.bash', 'shellscript'], ['.zsh', 'shellscript'],
  ['.swift', 'swift'],
  ['.kt', 'kotlin'], ['.kts', 'kotlin'],
  ['.scala', 'scala'], ['.sc', 'scala'],
  ['.dart', 'dart'],
  ['.pl', 'perl'], ['.pm', 'perl'],
  ['.r', 'r'],
  ['.yaml', 'yaml'], ['.yml', 'yaml'],
]);

function rebuildSupportedLangs() {
  const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
  const scanComments = cfg.get<boolean>('scanCodeComments', false);
  const codeLangs = cfg.get<string[]>('codeCommentLanguages', []);
  const scanCommitMessages = cfg.get<boolean>('scanCommitMessages', true);
  const allowed = new Set(SUPPORTED_CODE_LANGUAGES);
  SUPPORTED_LANGS = new Set<Language>([
    ...BASE_LANGS,
    ...(scanComments ? codeLangs.filter(l => allowed.has(l)) : []),
    ...(scanCommitMessages ? ['git-commit', 'scminput'] : []),
  ]);
}

// Module-level mutable rule state. Rebuilt on config change / rule-file change
// and scans read through it.
let RULES: RuleSet = { chars: new Map(), phrases: [], sources: [], charRegex: /(?!)/g, overridesApplied: 0 };

// One ignore matcher per workspace folder. Rebuilt on config change or when a
// .slopignore file is created/changed/deleted. Untitled and out-of-workspace
// docs bypass ignore filtering.
let IGNORE_BY_FOLDER = new Map<string, IgnoreMatcher>();

function isIgnoredDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file') return false;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return false;
  const matcher = IGNORE_BY_FOLDER.get(folder.uri.fsPath);
  if (!matcher || matcher.patterns.length === 0) return false;
  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  if (rel.startsWith('..')) return false;
  return matcher.ignores(rel);
}

// Findings keyed by document URI, stashed during scan so the hover provider
// can recover rule metadata (pattern, matched char) without rescanning.
const FINDINGS_BY_URI = new Map<string, Finding[]>();

// Explorer decoration provider. Marks files known to contain slop so users
// can see where work is pending without having to open each file. Populated
// lazily from two sources: documents scanned while open, and results from
// the workspace-scan command. Folders get the color via `propagate: true`;
// VS Code only re-queries ancestors when we fire events for them, so the
// provider walks up to the workspace root on every state change.
class SlopDecorationProvider implements vscode.FileDecorationProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private slopyPaths = new Set<string>();

  setFileState(uri: vscode.Uri, hasSlop: boolean): void {
    if (uri.scheme !== 'file') return;
    const p = uri.fsPath;
    const had = this.slopyPaths.has(p);
    if (had === hasSlop) return;
    if (hasSlop) this.slopyPaths.add(p);
    else this.slopyPaths.delete(p);
    this.emitter.fire(this.urisForPathAndAncestors(p));
  }

  applyScanResults(slopyPaths: Iterable<string>, scannedPaths: Iterable<string>): void {
    const next = new Set(slopyPaths);
    const changed: vscode.Uri[] = [];
    for (const p of scannedPaths) {
      const shouldMark = next.has(p);
      const isMarked = this.slopyPaths.has(p);
      if (shouldMark === isMarked) continue;
      if (shouldMark) this.slopyPaths.add(p);
      else this.slopyPaths.delete(p);
      for (const u of this.urisForPathAndAncestors(p)) changed.push(u);
    }
    if (changed.length > 0) this.emitter.fire(changed);
  }

  forgetPath(fsPath: string): void {
    if (!this.slopyPaths.delete(fsPath)) return;
    this.emitter.fire(this.urisForPathAndAncestors(fsPath));
  }

  clearAll(): void {
    if (this.slopyPaths.size === 0) return;
    this.slopyPaths.clear();
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return;
    if (this.slopyPaths.has(uri.fsPath)) {
      return {
        badge: 'S',
        tooltip: 'Contains LLM slop',
        color: new vscode.ThemeColor('list.warningForeground'),
        propagate: true,
      };
    }
    // Folders: return decoration if any tracked file lives under this path.
    // The tree rarely has more than a handful of slopy files, so an O(n)
    // scan per folder query is fine and avoids maintaining a separate index.
    const folderPrefix = uri.fsPath + path.sep;
    for (const p of this.slopyPaths) {
      if (p.startsWith(folderPrefix)) {
        return {
          tooltip: 'Contains LLM slop',
          color: new vscode.ThemeColor('list.warningForeground'),
          propagate: true,
        };
      }
    }
    return undefined;
  }

  private urisForPathAndAncestors(fsPath: string): vscode.Uri[] {
    const uris: vscode.Uri[] = [vscode.Uri.file(fsPath)];
    const folder = vscode.workspace.workspaceFolders?.find(f =>
      fsPath === f.uri.fsPath || fsPath.startsWith(f.uri.fsPath + path.sep)
    );
    if (!folder) return uris;
    let cur = path.dirname(fsPath);
    const root = folder.uri.fsPath;
    while (cur.length >= root.length && cur.startsWith(root)) {
      uris.push(vscode.Uri.file(cur));
      if (cur === root) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return uris;
  }
}

let DECORATION_PROVIDER: SlopDecorationProvider | undefined;

function updateDecorationForDocument(doc: vscode.TextDocument, findings: vscode.Diagnostic[]): void {
  if (!DECORATION_PROVIDER || doc.uri.scheme !== 'file') return;
  const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
  if (!cfg.get<boolean>('decorateExplorer', true)) return;
  DECORATION_PROVIDER.setFileState(doc.uri, findings.length > 0);
}

// Pending debounced refreshes keyed by document URI. Leading-edge scan fires
// immediately on the first change after idle; `trailing` flips to true when
// further changes arrive during the debounce window, triggering one more scan
// when the timer expires.
type PendingRefresh = { timer: NodeJS.Timeout; trailing: boolean };
const PENDING_REFRESH = new Map<string, PendingRefresh>();

function cancelPendingRefresh(uriKey: string): void {
  const p = PENDING_REFRESH.get(uriKey);
  if (p !== undefined) {
    clearTimeout(p.timer);
    PENDING_REFRESH.delete(uriKey);
  }
}

function getReplacement(char: string): string | undefined {
  return RULES.chars.get(char)?.replacement;
}

function diagnosticCode(d: vscode.Diagnostic): string | number | undefined {
  const c = d.code;
  if (typeof c === 'object' && c !== null) return c.value;
  return c;
}

function scanDocument(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const lang = doc.languageId as Language;
  if (!SUPPORTED_LANGS.has(lang)) {
    FINDINGS_BY_URI.delete(doc.uri.toString());
    return [];
  }
  const findings = scanText(doc.getText(), RULES, lang);
  FINDINGS_BY_URI.set(doc.uri.toString(), findings);
  return findings.map(f => {
    const start = doc.positionAt(f.offset);
    const end = doc.positionAt(f.offset + f.length);
    const d = new vscode.Diagnostic(new vscode.Range(start, end), f.message, severityToVscode(f.severity));
    d.source = SOURCE;
    d.code = { value: f.code, target: DOCS_URI };
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
      if (diag.source !== SOURCE || diagnosticCode(diag) !== 'char') continue;
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
      d.source === SOURCE && diagnosticCode(d) === 'char' &&
      getReplacement(document.getText(d.range)) !== undefined
    );
    const fixable = vscode.languages.getDiagnostics(document.uri)
      .filter(d => d.source === SOURCE && diagnosticCode(d) === 'char')
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
// Hover provider: show rule metadata + ready-to-copy ignore snippet
// ---------------------------------------------------------------------------

function charCodepointSpec(char: string): string {
  return 'U+' + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
}

function ignoreSpecFor(f: Finding): string {
  return f.code === 'phrase' && f.rulePattern !== undefined
    ? `phrase:${f.rulePattern}`
    : `char:${charCodepointSpec(f.matchText)}`;
}

class SlopHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const findings = FINDINGS_BY_URI.get(document.uri.toString());
    if (!findings || findings.length === 0) return;

    const offset = document.offsetAt(position);
    const matched = findings.filter(f => offset >= f.offset && offset < f.offset + f.length);
    if (matched.length === 0) return;

    const blocks = matched.map(f => {
      const spec = ignoreSpecFor(f);
      const heading = f.code === 'phrase' ? 'LLM-style phrase' : 'Flagged character';
      const lines = [
        `**${heading}** -- \`${f.source}\``,
        '',
        `Rule selector: \`${spec}\``,
        '',
        'Suppress the next line:',
        '```markdown',
        `<!-- slop-disable-next-line ${spec} -->`,
        '```',
      ];
      return lines.join('\n');
    });

    const md = new vscode.MarkdownString(blocks.join('\n\n---\n\n'));
    md.isTrusted = false;
    md.supportHtml = false;
    return new vscode.Hover(md);
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
    if (!enabled || !SUPPORTED_LANGS.has(doc.languageId as Language) || isIgnoredDocument(doc)) {
      collection.delete(doc.uri);
      FINDINGS_BY_URI.delete(doc.uri.toString());
      updateDecorationForDocument(doc, []);
      return;
    }
    const diags = scanDocument(doc);
    collection.set(doc.uri, diags);
    updateDecorationForDocument(doc, diags);
  };

  // Leading+trailing debounce: first change after idle triggers an immediate
  // scan so feedback stays snappy; subsequent changes within the window
  // collapse into one trailing scan when the timer fires.
  const scheduleRefresh = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    const raw = vscode.workspace.getConfiguration('llmSlopDetector').get<number>('debounceMs', 150);
    const ms = Number.isFinite(raw) ? Math.max(0, Math.min(2000, raw)) : 150;

    if (ms === 0) {
      cancelPendingRefresh(key);
      refresh(doc);
      return;
    }

    const existing = PENDING_REFRESH.get(key);
    if (existing !== undefined) {
      existing.trailing = true;
      return;
    }

    refresh(doc);
    const entry: PendingRefresh = { timer: undefined as unknown as NodeJS.Timeout, trailing: false };
    entry.timer = setTimeout(() => {
      const current = PENDING_REFRESH.get(key);
      PENDING_REFRESH.delete(key);
      if (current?.trailing) refresh(doc);
    }, ms);
    PENDING_REFRESH.set(key, entry);
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'llmSlopDetector.toggle';
  context.subscriptions.push(status);

  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !SUPPORTED_LANGS.has(editor.document.languageId as Language) || isIgnoredDocument(editor.document)) {
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
    const chars = diags.filter(d => diagnosticCode(d) === 'char').length;
    const phrases = diags.filter(d => diagnosticCode(d) === 'phrase').length;
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

  const reloadIgnore = () => {
    const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
    const extra = cfg.get<string[]>('exclude', []);
    const next = new Map<string, IgnoreMatcher>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      next.set(folder.uri.fsPath, loadIgnoreMatcher(folder.uri.fsPath, extra));
    }
    IGNORE_BY_FOLDER = next;
  };

  const reloadRules = () => {
    RULES = loadRules(context.extensionUri);
    reloadIgnore();
    rebuildSupportedLangs();
    const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
    const decorate = cfg.get<boolean>('decorateExplorer', true);
    const enabled = cfg.get<boolean>('enabled', true);
    if (!decorate || !enabled) DECORATION_PROVIDER?.clearAll();
    vscode.workspace.textDocuments.forEach(refresh);
    updateStatus();
  };

  DECORATION_PROVIDER = new SlopDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(DECORATION_PROVIDER));

  reloadRules();

  // Live-reload when a local .llmsloprc.json is created/changed/deleted
  // anywhere in the workspace. The loader itself only reads the files at
  // workspace roots; nested matches just trigger a harmless reload.
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${LOCAL_RULES_FILENAME}`);
  const ignoreWatcher = vscode.workspace.createFileSystemWatcher(`**/${SLOPIGNORE_FILENAME}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(reloadRules),
    watcher.onDidCreate(reloadRules),
    watcher.onDidDelete(reloadRules),
    ignoreWatcher,
    ignoreWatcher.onDidChange(reloadRules),
    ignoreWatcher.onDidCreate(reloadRules),
    ignoreWatcher.onDidDelete(reloadRules),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => { refresh(doc); updateStatus(); }),
    vscode.workspace.onDidChangeTextDocument(e => { scheduleRefresh(e.document); }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      const key = doc.uri.toString();
      cancelPendingRefresh(key);
      collection.delete(doc.uri);
      FINDINGS_BY_URI.delete(key);
      updateStatus();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(reloadRules),
    vscode.workspace.onDidDeleteFiles(e => {
      for (const uri of e.files) DECORATION_PROVIDER?.forgetPath(uri.fsPath);
    }),
    vscode.workspace.onDidRenameFiles(e => {
      for (const { oldUri } of e.files) DECORATION_PROVIDER?.forgetPath(oldUri.fsPath);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(reloadRules),
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
    vscode.languages.registerHoverProvider(CODE_ACTION_SELECTORS, new SlopHoverProvider()),
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
    vscode.commands.registerCommand('llmSlopDetector.scanSelection', () => scanSelection()),
    vscode.commands.registerCommand('llmSlopDetector.scanWorkspace', () => scanWorkspace()),
    vscode.commands.registerCommand('llmSlopDetector.showRuleSources', async () => {
      if (RULES.sources.length === 0) {
        vscode.window.showInformationMessage('LLM Slop Detector: no rule sources loaded.');
        return;
      }
      const items: vscode.QuickPickItem[] = RULES.sources.map(s => ({
        label: `$(list-unordered) ${s.name}${s.version ? ` v${s.version}` : ''}`,
        description: `${s.charCount} char${s.charCount === 1 ? '' : 's'}, ${s.phraseCount} phrase${s.phraseCount === 1 ? '' : 's'}`,
        detail: s.description ? `${s.description} (${s.origin})` : s.origin,
      }));
      if (RULES.overridesApplied > 0) {
        items.push({
          label: `$(settings-gear) ${RULES.overridesApplied} severity override${RULES.overridesApplied === 1 ? '' : 's'} applied`,
          description: 'via llmSlopDetector.severityOverrides',
        });
      }
      await vscode.window.showQuickPick(items, { title: 'LLM Slop Detector: loaded rule sources' });
    })
  );

  void maybeShowOnboarding(context);
}

// ---------------------------------------------------------------------------
// Scan selection
// ---------------------------------------------------------------------------

function severityCodicon(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    case vscode.DiagnosticSeverity.Hint: return 'lightbulb';
  }
}

async function scanSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('LLM Slop Detector: no active editor.');
    return;
  }
  const doc = editor.document;
  if (!SUPPORTED_LANGS.has(doc.languageId as Language)) {
    vscode.window.showInformationMessage(
      `LLM Slop Detector: ${doc.languageId} is not a scanned language.`
    );
    return;
  }

  const sel = editor.selection;
  const scope = sel.isEmpty ? doc.lineAt(sel.start).range : new vscode.Range(sel.start, sel.end);

  const diags = vscode.languages.getDiagnostics(doc.uri)
    .filter(d => d.source === SOURCE && scope.intersection(d.range))
    .sort((a, b) => a.range.start.compareTo(b.range.start));

  if (diags.length === 0) {
    vscode.window.showInformationMessage(
      sel.isEmpty
        ? 'LLM Slop Detector: no findings on this line.'
        : 'LLM Slop Detector: no findings in selection.'
    );
    return;
  }

  type Item = vscode.QuickPickItem & { diagnostic: vscode.Diagnostic };
  const items: Item[] = diags.map(d => ({
    label: `$(${severityCodicon(d.severity)}) ${doc.getText(d.range).trim() || String(d.code)}`,
    description: `Line ${d.range.start.line + 1}, col ${d.range.start.character + 1}`,
    detail: d.message,
    diagnostic: d,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    title: `LLM Slop in ${sel.isEmpty ? 'line' : 'selection'} (${diags.length} finding${diags.length === 1 ? '' : 's'})`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (pick) {
    editor.revealRange(pick.diagnostic.range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(pick.diagnostic.range.start, pick.diagnostic.range.end);
  }
}

// ---------------------------------------------------------------------------
// Scan workspace
// ---------------------------------------------------------------------------

type WorkspaceHit = {
  uri: vscode.Uri;
  relPath: string;
  finding: Finding;
  displayLine: number;
  displayCol: number;
};

function buildScanExtensionMap(): Map<string, Language> {
  const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
  const out = new Map<string, Language>(PROSE_EXTENSIONS);
  if (cfg.get<boolean>('scanCodeComments', false)) {
    const allowed = new Set(SUPPORTED_CODE_LANGUAGES);
    const enabled = new Set(cfg.get<string[]>('codeCommentLanguages', []).filter(l => allowed.has(l)));
    for (const [ext, lang] of CODE_EXTENSIONS) {
      if (enabled.has(lang)) out.set(ext, lang);
    }
  }
  return out;
}

function walkWorkspaceFolder(
  rootDir: string,
  currentDir: string,
  extensions: ReadonlyMap<string, Language>,
  ignore: IgnoreMatcher | undefined,
  push: (absPath: string, lang: Language) => void,
  token: vscode.CancellationToken,
): void {
  if (token.isCancellationRequested) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (token.isCancellationRequested) return;
    // Same hard-coded skips as the CLI walker: dotfiles, node_modules, build out.
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'out') continue;
    const full = path.join(currentDir, e.name);
    const rel = path.relative(rootDir, full);
    if (e.isDirectory()) {
      if (ignore && ignore.patterns.length > 0 && ignore.ignores(rel, true)) continue;
      walkWorkspaceFolder(rootDir, full, extensions, ignore, push, token);
    } else if (e.isFile()) {
      const lang = extensions.get(path.extname(e.name).toLowerCase());
      if (lang === undefined) continue;
      if (ignore && ignore.patterns.length > 0 && ignore.ignores(rel, false)) continue;
      push(full, lang);
    }
  }
}

async function scanWorkspace(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showInformationMessage('LLM Slop Detector: open a folder to scan the workspace.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('llmSlopDetector');
  if (!cfg.get<boolean>('enabled', true)) {
    vscode.window.showInformationMessage('LLM Slop Detector is disabled. Enable it before scanning.');
    return;
  }

  const extensions = buildScanExtensionMap();

  type Target = { absPath: string; uri: vscode.Uri; lang: Language; relPath: string };

  const result = await vscode.window.withProgress<{ hits: WorkspaceHit[]; scannedPaths: Set<string> } | undefined>({
    location: vscode.ProgressLocation.Notification,
    title: 'LLM Slop Detector: scanning workspace',
    cancellable: true,
  }, async (progress, token) => {
    const targets: Target[] = [];
    for (const folder of folders) {
      if (token.isCancellationRequested) return undefined;
      const matcher = IGNORE_BY_FOLDER.get(folder.uri.fsPath);
      walkWorkspaceFolder(folder.uri.fsPath, folder.uri.fsPath, extensions, matcher, (absPath, lang) => {
        targets.push({
          absPath,
          uri: vscode.Uri.file(absPath),
          lang,
          relPath: path.relative(folder.uri.fsPath, absPath),
        });
      }, token);
    }
    if (token.isCancellationRequested) return undefined;
    const scannedPaths = new Set<string>(targets.map(t => t.absPath));
    if (targets.length === 0) return { hits: [], scannedPaths };

    // Use the in-memory text of any open document so unsaved changes are
    // reflected in the scan, falling back to the on-disk version otherwise.
    const openText = new Map<string, string>();
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme === 'file') openText.set(d.uri.fsPath, d.getText());
    }

    progress.report({ message: `${targets.length} file${targets.length === 1 ? '' : 's'}` });

    const out: WorkspaceHit[] = [];
    let next = 0;
    let done = 0;
    const total = targets.length;
    const concurrency = Math.min(8, total);

    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < total) {
        if (token.isCancellationRequested) return;
        const t = targets[next++];
        let text: string;
        const open = openText.get(t.absPath);
        if (open !== undefined) {
          text = open;
        } else {
          try {
            text = await fsp.readFile(t.absPath, 'utf8');
          } catch {
            done++;
            continue;
          }
        }
        const findings = scanText(text, RULES, t.lang);
        for (const f of findings) {
          const lc = offsetToLineCol(text, f.offset);
          out.push({ uri: t.uri, relPath: t.relPath, finding: f, displayLine: lc.line, displayCol: lc.col });
        }
        done++;
        if (done === total || done % 25 === 0) {
          progress.report({ message: `${done}/${total} scanned, ${out.length} finding${out.length === 1 ? '' : 's'}` });
        }
      }
    }));

    if (token.isCancellationRequested) return undefined;
    return { hits: out, scannedPaths };
  });

  if (result === undefined) return;
  const { hits, scannedPaths } = result;
  if (cfg.get<boolean>('decorateExplorer', true) && DECORATION_PROVIDER) {
    const slopyAbsPaths = new Set<string>();
    for (const h of hits) slopyAbsPaths.add(h.uri.fsPath);
    DECORATION_PROVIDER.applyScanResults(slopyAbsPaths, scannedPaths);
  }
  if (hits.length === 0) {
    vscode.window.showInformationMessage('LLM Slop Detector: no findings in the workspace.');
    return;
  }

  hits.sort((a, b) => {
    const cmp = a.relPath.localeCompare(b.relPath);
    if (cmp !== 0) return cmp;
    return a.finding.offset - b.finding.offset;
  });

  const counts: Record<Severity, number> = { error: 0, warning: 0, information: 0, hint: 0 };
  const fileSet = new Set<string>();
  for (const h of hits) {
    counts[h.finding.severity]++;
    fileSet.add(h.relPath);
  }
  const summaryParts: string[] = [];
  if (counts.error) summaryParts.push(`${counts.error} error${counts.error === 1 ? '' : 's'}`);
  if (counts.warning) summaryParts.push(`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`);
  if (counts.information) summaryParts.push(`${counts.information} info`);
  if (counts.hint) summaryParts.push(`${counts.hint} hint${counts.hint === 1 ? '' : 's'}`);
  const summary = `${hits.length} finding${hits.length === 1 ? '' : 's'} in ${fileSet.size} file${fileSet.size === 1 ? '' : 's'} (${summaryParts.join(', ')})`;

  type Item = vscode.QuickPickItem & { hit: WorkspaceHit };
  const items: Item[] = hits.map(h => ({
    label: `$(${severityCodicon(severityToVscode(h.finding.severity))}) ${h.finding.matchText.trim() || h.finding.code}`,
    description: `${h.relPath}:${h.displayLine}:${h.displayCol}`,
    detail: h.finding.message,
    hit: h,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    title: summary,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;

  const doc = await vscode.workspace.openTextDocument(pick.hit.uri);
  const editor = await vscode.window.showTextDocument(doc);
  const start = doc.positionAt(pick.hit.finding.offset);
  const end = doc.positionAt(pick.hit.finding.offset + pick.hit.finding.length);
  const range = new vscode.Range(start, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.end);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

// Versioned so we can re-trigger onboarding for material UX changes without
// spamming users who have already seen the current version. Bump the suffix
// when you want everyone to see the toast again.
const ONBOARDING_KEY = 'llmSlopDetector.onboarding.v2';

async function maybeShowOnboarding(context: vscode.ExtensionContext) {
  if (context.globalState.get<boolean>(ONBOARDING_KEY, false)) return;
  await showOnboarding(context);
}

async function showOnboarding(context: vscode.ExtensionContext) {
  const openPacks = 'Browse rule packs';
  const learnMore = 'Learn more';
  const dismiss = 'Dismiss';

  const choice = await vscode.window.showInformationMessage(
    'LLM Slop Detector is watching Markdown and plain-text files. Six optional rule packs (academic, cliches, fiction, claudeisms, structural, security) add broader coverage -- opt into them in settings.',
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

export function deactivate() {
  for (const { timer } of PENDING_REFRESH.values()) clearTimeout(timer);
  PENDING_REFRESH.clear();
}

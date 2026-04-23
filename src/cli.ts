#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { BUILTIN_PACKS, findLocalRulePathFromCwd, loadRules } from './core/rules';
import { Finding, RuleSet, SEVERITY_RANK, Severity } from './core/types';
import { Language, offsetToLineCol, scanText } from './core/scan';

type Format = 'pretty' | 'json' | 'sarif';

type CliOptions = {
  paths: string[];
  format: Format;
  packs: string[];
  useBuiltin: boolean;
  configPath?: string;
  severity: Severity;
  quiet: boolean;
  scanComments: boolean;
};

type FileReport = {
  path: string;
  findings: Finding[];
};

const PROSE_EXTENSIONS = new Map<string, Language>([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.mdown', 'markdown'],
  ['.txt', 'plaintext'],
  ['.text', 'plaintext'],
]);

// Files git passes to commit-msg / prepare-commit-msg hooks, recognised by
// basename so `llm-slop .git/COMMIT_EDITMSG` works without a flag.
const GIT_MESSAGE_BASENAMES = new Map<string, Language>([
  ['COMMIT_EDITMSG', 'git-commit'],
  ['MERGE_MSG', 'git-commit'],
  ['TAG_EDITMSG', 'git-commit'],
  ['EDIT_DESCRIPTION', 'git-commit'],
]);

const CODE_EXTENSIONS = new Map<string, Language>([
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

const HELP = `llm-slop-detector [options] <paths...>

Scan markdown and plaintext files for LLM-style phrases and invisible Unicode.
With --scan-comments, also scan comments and docstrings in source code.

Options:
  -f, --format <pretty|json|sarif>  Output format (default: pretty)
      --pack <name,...>             Enable built-in rule packs
                                    (${BUILTIN_PACKS.join(', ')})
      --no-builtin                  Skip the built-in core rule list
      --config <path>               Path to a .llmsloprc.json file
                                    (default: nearest ancestor of cwd)
  -s, --severity <level>            Fail threshold: error | warning |
                                    information | hint (default: information)
      --scan-comments               Scan comments/docstrings in source code
                                    files (.ts, .py, .rs, .go, etc)
  -q, --quiet                       Suppress the summary line
  -h, --help                        Show this help
  -v, --version                     Print version

Exit code: 0 if no findings at or above the severity threshold, 1 otherwise.

Examples:
  llm-slop-detector README.md
  llm-slop-detector --pack academic,cliches docs/
  llm-slop-detector --format=json . > slop.json
  llm-slop-detector --scan-comments src/
`;

function parseCli(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: 'string', short: 'f', default: 'pretty' },
      pack: { type: 'string' },
      'no-builtin': { type: 'boolean', default: false },
      config: { type: 'string' },
      severity: { type: 'string', short: 's', default: 'information' },
      'scan-comments': { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    strict: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.values.version) {
    process.stdout.write(readPackageVersion() + '\n');
    process.exit(0);
  }

  const format = parsed.values.format as string;
  if (format !== 'pretty' && format !== 'json' && format !== 'sarif') {
    die(`unknown --format: ${format}`);
  }

  const severityRaw = parsed.values.severity as string;
  if (!(severityRaw in SEVERITY_RANK)) {
    die(`unknown --severity: ${severityRaw}`);
  }

  const packsRaw = parsed.values.pack as string | undefined;
  const packs = packsRaw ? packsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  for (const p of packs) {
    if (!(BUILTIN_PACKS as readonly string[]).includes(p)) {
      die(`unknown pack: ${p}. Known: ${BUILTIN_PACKS.join(', ')}`);
    }
  }

  if (parsed.positionals.length === 0) {
    die('no paths given. Try --help.');
  }

  return {
    paths: parsed.positionals,
    format: format as Format,
    packs,
    useBuiltin: !parsed.values['no-builtin'],
    configPath: parsed.values.config as string | undefined,
    severity: severityRaw as Severity,
    quiet: parsed.values.quiet as boolean,
    scanComments: parsed.values['scan-comments'] as boolean,
  };
}

function die(msg: string): never {
  process.stderr.write(`llm-slop: ${msg}\n`);
  process.exit(2);
}

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function extensionRoot(): string {
  // Compiled CLI lives at out/cli.js; the extension root is its parent.
  return path.resolve(__dirname, '..');
}

function collectFiles(paths: string[], extensions: Map<string, Language>): string[] {
  const result: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      process.stderr.write(`llm-slop: path not found: ${p}\n`);
      continue;
    }
    if (stat.isFile()) {
      const ext = path.extname(abs).toLowerCase();
      const base = path.basename(abs);
      if (extensions.has(ext) || GIT_MESSAGE_BASENAMES.has(base)) {
        result.push(abs);
      } else {
        process.stderr.write(`llm-slop: skipping ${p} (unrecognized extension; add --scan-comments for source code)\n`);
      }
    } else if (stat.isDirectory()) {
      walkDir(abs, extensions, result);
    }
  }
  return result;
}

function walkDir(dir: string, extensions: Map<string, Language>, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'out') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkDir(full, extensions, out);
    } else if (e.isFile() && extensions.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
}

function languageFor(file: string, extensions: Map<string, Language>): Language {
  const byBasename = GIT_MESSAGE_BASENAMES.get(path.basename(file));
  if (byBasename !== undefined) return byBasename;
  return extensions.get(path.extname(file).toLowerCase()) ?? 'plaintext';
}

function scanFile(file: string, rules: RuleSet, extensions: Map<string, Language>): Finding[] {
  const text = fs.readFileSync(file, 'utf8');
  return scanText(text, rules, languageFor(file, extensions));
}

function shouldFail(reports: FileReport[], threshold: Severity): boolean {
  const thresholdRank = SEVERITY_RANK[threshold];
  for (const r of reports) {
    for (const f of r.findings) {
      if (SEVERITY_RANK[f.severity] <= thresholdRank) return true;
    }
  }
  return false;
}

function formatPretty(reports: FileReport[], quiet: boolean): string {
  const lines: string[] = [];
  let total = 0;
  const counts: Record<Severity, number> = { error: 0, warning: 0, information: 0, hint: 0 };
  const sevTag: Record<Severity, string> = { error: 'error', warning: 'warn', information: 'info', hint: 'hint' };

  for (const r of reports) {
    if (r.findings.length === 0) continue;
    const text = fs.readFileSync(r.path, 'utf8');
    const rel = path.relative(process.cwd(), r.path) || r.path;
    for (const f of r.findings) {
      const { line, col } = offsetToLineCol(text, f.offset);
      lines.push(`${rel}:${line}:${col}  ${sevTag[f.severity].padEnd(5)}  ${f.message}`);
      counts[f.severity]++;
      total++;
    }
  }

  if (!quiet) {
    if (total === 0) {
      lines.push('No slop found.');
    } else {
      const parts: string[] = [];
      for (const s of ['error', 'warning', 'information', 'hint'] as const) {
        if (counts[s] > 0) parts.push(`${counts[s]} ${s}`);
      }
      lines.push('');
      lines.push(`${total} finding${total === 1 ? '' : 's'} (${parts.join(', ')})`);
    }
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function formatJson(reports: FileReport[]): string {
  const out: unknown[] = [];
  for (const r of reports) {
    if (r.findings.length === 0) continue;
    const text = fs.readFileSync(r.path, 'utf8');
    const rel = path.relative(process.cwd(), r.path) || r.path;
    for (const f of r.findings) {
      const start = offsetToLineCol(text, f.offset);
      const end = offsetToLineCol(text, f.offset + f.length);
      out.push({
        path: rel,
        line: start.line,
        col: start.col,
        endLine: end.line,
        endCol: end.col,
        code: f.code,
        severity: f.severity,
        message: f.message,
        source: f.source,
        rulePattern: f.rulePattern,
      });
    }
  }
  return JSON.stringify(out, null, 2) + '\n';
}

function formatSarif(reports: FileReport[], version: string): string {
  const sarifLevel: Record<Severity, 'error' | 'warning' | 'note'> = {
    error: 'error',
    warning: 'warning',
    information: 'note',
    hint: 'note',
  };
  const results: unknown[] = [];
  for (const r of reports) {
    if (r.findings.length === 0) continue;
    const text = fs.readFileSync(r.path, 'utf8');
    const rel = path.relative(process.cwd(), r.path) || r.path;
    for (const f of r.findings) {
      const start = offsetToLineCol(text, f.offset);
      const end = offsetToLineCol(text, f.offset + f.length);
      results.push({
        ruleId: f.code === 'char' ? `char:${f.matchText}` : `phrase:${f.rulePattern ?? f.matchText}`,
        level: sarifLevel[f.severity],
        message: { text: f.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: rel },
            region: {
              startLine: start.line,
              startColumn: start.col,
              endLine: end.line,
              endColumn: end.col,
            },
          },
        }],
      });
    }
  }
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'llm-slop-detector',
          version,
          informationUri: 'https://github.com/mandakan/llm-slop-detector',
        },
      },
      results,
    }],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}

function main(): void {
  const opts = parseCli(process.argv.slice(2));

  const localRulePaths: string[] = [];
  if (opts.configPath) {
    if (!fs.existsSync(opts.configPath)) die(`--config not found: ${opts.configPath}`);
    localRulePaths.push(path.resolve(opts.configPath));
  } else {
    const found = findLocalRulePathFromCwd(process.cwd());
    if (found) localRulePaths.push(found);
  }

  const rules = loadRules({
    extensionRoot: extensionRoot(),
    useBuiltin: opts.useBuiltin,
    enabledPacks: opts.packs,
    localRulePaths,
    userPhrases: [],
    charReplacements: {},
  });

  const extensions = new Map<string, Language>(PROSE_EXTENSIONS);
  if (opts.scanComments) {
    for (const [k, v] of CODE_EXTENSIONS) extensions.set(k, v);
  }

  const files = collectFiles(opts.paths, extensions);
  const reports: FileReport[] = files.map(f => ({ path: f, findings: scanFile(f, rules, extensions) }));

  let output: string;
  if (opts.format === 'json') output = formatJson(reports);
  else if (opts.format === 'sarif') output = formatSarif(reports, readPackageVersion());
  else output = formatPretty(reports, opts.quiet);

  process.stdout.write(output);
  process.exit(shouldFail(reports, opts.severity) ? 1 : 0);
}

main();

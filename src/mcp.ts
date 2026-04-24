#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BUILTIN_PACKS, findLocalRulePathFromCwd, loadRules } from './core/rules';
import { Language, offsetToLineCol, scanText } from './core/scan';
import { RuleSet } from './core/types';

type StartupConfig = {
  extensionRoot: string;
  useBuiltin: boolean;
  packs: string[];
  localRulePaths: string[];
};

const HELP = `llm-slop-mcp [options]

Stdio MCP server that exposes the LLM Slop Detector as a tool. Intended to be
spawned by MCP clients (Claude Code, etc), not run interactively.

Options:
  --pack <name,...>   Enable built-in rule packs
                      (${BUILTIN_PACKS.join(', ')})
  --no-builtin        Skip the built-in core rule list
  --config <path>     Path to a .llmsloprc.json file
                      (default: nearest ancestor of cwd)
  -h, --help          Show this help
  -v, --version       Print version

Environment variables (override CLI flags when set):
  LLM_SLOP_PACKS       Comma-separated list of packs
  LLM_SLOP_NO_BUILTIN  Set to "1" or "true" to skip built-in rules
  LLM_SLOP_CONFIG      Path to a .llmsloprc.json file

Tools exposed:
  scan_text  Input: { text, language?, packs? }  -> Finding[]
  list_rules Input: { source? }                   -> rule summary
`;

function die(msg: string): never {
  process.stderr.write(`llm-slop-mcp: ${msg}\n`);
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

function parseStartup(argv: string[]): StartupConfig {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      pack: { type: 'string' },
      'no-builtin': { type: 'boolean', default: false },
      config: { type: 'string' },
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

  const envPacks = process.env.LLM_SLOP_PACKS;
  const packsRaw = envPacks ?? (parsed.values.pack as string | undefined);
  const packs = packsRaw ? packsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  for (const p of packs) {
    if (!(BUILTIN_PACKS as readonly string[]).includes(p)) {
      die(`unknown pack: ${p}. Known: ${BUILTIN_PACKS.join(', ')}`);
    }
  }

  const envNoBuiltin = process.env.LLM_SLOP_NO_BUILTIN;
  const envNoBuiltinSet = envNoBuiltin === '1' || envNoBuiltin === 'true';
  const useBuiltin = !(envNoBuiltinSet || parsed.values['no-builtin']);

  const envConfig = process.env.LLM_SLOP_CONFIG;
  const configPath = envConfig ?? (parsed.values.config as string | undefined);
  const localRulePaths: string[] = [];
  if (configPath) {
    if (!fs.existsSync(configPath)) die(`--config not found: ${configPath}`);
    localRulePaths.push(path.resolve(configPath));
  } else {
    const found = findLocalRulePathFromCwd(process.cwd());
    if (found) localRulePaths.push(found);
  }

  return {
    extensionRoot: path.resolve(__dirname, '..'),
    useBuiltin,
    packs,
    localRulePaths,
  };
}

function buildRules(cfg: StartupConfig, packOverride?: string[]): RuleSet {
  return loadRules({
    extensionRoot: cfg.extensionRoot,
    useBuiltin: cfg.useBuiltin,
    enabledPacks: packOverride ?? cfg.packs,
    localRulePaths: cfg.localRulePaths,
    userPhrases: [],
    charReplacements: {},
    severityOverrides: {},
  });
}

function validatePackList(packs: unknown): string[] {
  if (!Array.isArray(packs)) {
    throw new Error('packs must be an array of strings');
  }
  const out: string[] = [];
  for (const p of packs) {
    if (typeof p !== 'string') throw new Error('packs must be an array of strings');
    if (!(BUILTIN_PACKS as readonly string[]).includes(p)) {
      throw new Error(`unknown pack: ${p}. Known: ${BUILTIN_PACKS.join(', ')}`);
    }
    out.push(p);
  }
  return out;
}

function handleScanText(args: Record<string, unknown>, cfg: StartupConfig, defaultRules: RuleSet): unknown[] {
  const text = args.text;
  if (typeof text !== 'string') throw new Error('text must be a string');
  const language = typeof args.language === 'string' ? args.language : 'markdown';

  let rules = defaultRules;
  if (args.packs !== undefined) {
    const packs = validatePackList(args.packs);
    rules = buildRules(cfg, packs);
  }

  const findings = scanText(text, rules, language as Language);
  return findings.map(f => {
    const start = offsetToLineCol(text, f.offset);
    const end = offsetToLineCol(text, f.offset + f.length);
    return {
      line: start.line,
      col: start.col,
      endLine: end.line,
      endCol: end.col,
      offset: f.offset,
      length: f.length,
      matchText: f.matchText,
      code: f.code,
      severity: f.severity,
      message: f.message,
      source: f.source,
      rulePattern: f.rulePattern,
    };
  });
}

function handleListRules(args: Record<string, unknown>, rules: RuleSet): unknown {
  const sourceFilter = typeof args.source === 'string' ? args.source : undefined;

  const chars = Array.from(rules.chars.values())
    .filter(c => sourceFilter === undefined || c.source === sourceFilter)
    .map(c => ({
      char: c.char,
      codepoint: `U+${c.char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
      name: c.name,
      severity: c.severity,
      replacement: c.replacement,
      suggestion: c.suggestion,
      source: c.source,
    }));

  const phrases = rules.phrases
    .filter(p => sourceFilter === undefined || p.source === sourceFilter)
    .map(p => ({
      pattern: p.pattern,
      reason: p.reason,
      severity: p.severity,
      source: p.source,
    }));

  return {
    sources: rules.sources,
    chars,
    phrases,
    overridesApplied: rules.overridesApplied,
  };
}

async function main(): Promise<void> {
  const cfg = parseStartup(process.argv.slice(2));
  const defaultRules = buildRules(cfg);

  const server = new Server(
    { name: 'llm-slop-detector', version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'scan_text',
        description:
          'Scan text for LLM-style phrases and invisible Unicode using the LLM Slop Detector ruleset. Returns an array of findings with line/col positions. Use language="markdown" (default) to honour fenced code / frontmatter exclusions, "plaintext" to scan everything, or a source-code language id (typescript, python, etc) to scan only comments and docstrings.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The text to scan.',
            },
            language: {
              type: 'string',
              description: 'Language id. Defaults to "markdown". Use "plaintext", "markdown", "git-commit", or a code language id (typescript, python, rust, go, etc).',
            },
            packs: {
              type: 'array',
              items: { type: 'string', enum: [...BUILTIN_PACKS] },
              description: 'Override the server\'s enabled packs for this call.',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'list_rules',
        description: 'List the rules currently loaded by the server (chars and phrases), optionally filtered by source name.',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Only include rules whose source matches this name (e.g. "built-in", "pack:academic").',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const argsObj = (args ?? {}) as Record<string, unknown>;
    try {
      if (name === 'scan_text') {
        const findings = handleScanText(argsObj, cfg, defaultRules);
        return {
          content: [{ type: 'text', text: JSON.stringify(findings, null, 2) }],
        };
      }
      if (name === 'list_rules') {
        const summary = handleListRules(argsObj, defaultRules);
        return {
          content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        };
      }
      return {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(e => {
  process.stderr.write(`llm-slop-mcp: fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});

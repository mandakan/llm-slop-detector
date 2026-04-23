type Range = [number, number];

export type CommentScanner = (text: string) => Range[];

const C_STYLE_LANGS = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
  'rust',
  'go',
  'java',
  'csharp',
  'cpp',
  'c',
  'php',
  'swift',
  'kotlin',
  'scala',
  'dart',
]);

const PYTHON_LANGS = new Set(['python']);

const HASH_LANGS = new Set(['ruby', 'shellscript', 'perl', 'r', 'yaml']);

export const SUPPORTED_CODE_LANGUAGES: readonly string[] = [
  ...C_STYLE_LANGS,
  ...PYTHON_LANGS,
  ...HASH_LANGS,
].sort();

export function getCommentScanner(language: string): CommentScanner | null {
  if (C_STYLE_LANGS.has(language)) return scanCStyleComments;
  if (PYTHON_LANGS.has(language)) return scanPythonComments;
  if (HASH_LANGS.has(language)) return scanHashComments;
  return null;
}

// Extract // line comments and /* */ block comments, skipping contents of
// string literals (", ', `). Regex literals, division operators, and exotic
// lexical edge cases are not disambiguated -- acceptable given findings are
// Information severity and false positives are suppressible inline.
function scanCStyleComments(text: string): Range[] {
  const ranges: Range[] = [];
  const n = text.length;
  let i = 0;
  let inString: '"' | "'" | '`' | null = null;

  while (i < n) {
    const c = text.charCodeAt(i);

    if (inString !== null) {
      if (c === 92 /* \ */ && i + 1 < n) { i += 2; continue; }
      if (text[i] === inString) inString = null;
      i++;
      continue;
    }

    if (c === 47 /* / */ && i + 1 < n) {
      const next = text.charCodeAt(i + 1);
      if (next === 47 /* / */) {
        const start = i;
        const nl = text.indexOf('\n', i + 2);
        const end = nl === -1 ? n : nl;
        ranges.push([start, end]);
        i = end;
        continue;
      }
      if (next === 42 /* * */) {
        const start = i;
        const close = text.indexOf('*/', i + 2);
        const end = close === -1 ? n : close + 2;
        ranges.push([start, end]);
        i = end;
        continue;
      }
    }

    if (c === 34 /* " */ || c === 39 /* ' */ || c === 96 /* ` */) {
      inString = text[i] as '"' | "'" | '`';
      i++;
      continue;
    }

    i++;
  }

  return ranges;
}

// Extract # line comments and triple-quoted strings. Triple-quoted strings
// are scanned whether they're docstrings or raw data -- Option A can't
// distinguish without a parser, and the issue accepts this tradeoff.
function scanPythonComments(text: string): Range[] {
  const ranges: Range[] = [];
  const n = text.length;
  let i = 0;
  let inString: { quote: string; triple: boolean } | null = null;

  while (i < n) {
    if (inString !== null) {
      if (inString.triple) {
        if (text.startsWith(inString.quote.repeat(3), i)) {
          i += 3;
          inString = null;
          continue;
        }
      } else {
        if (text[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (text[i] === inString.quote || text[i] === '\n') {
          inString = null;
        }
      }
      i++;
      continue;
    }

    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const quote = text[i];
      const start = i;
      i += 3;
      const closerIdx = text.indexOf(quote.repeat(3), i);
      const end = closerIdx === -1 ? n : closerIdx + 3;
      ranges.push([start, end]);
      i = end;
      continue;
    }

    if (text[i] === '#') {
      const start = i;
      const nl = text.indexOf('\n', i + 1);
      const end = nl === -1 ? n : nl;
      ranges.push([start, end]);
      i = end;
      continue;
    }

    if (text[i] === '"' || text[i] === "'") {
      inString = { quote: text[i], triple: false };
      i++;
      continue;
    }

    i++;
  }

  return ranges;
}

// Extract # line comments, skipping contents of string literals.
// Works for Ruby, shell, Perl, R, YAML, etc. Heredocs and `$# ` parameter
// expansion are not specially handled.
function scanHashComments(text: string): Range[] {
  const ranges: Range[] = [];
  const n = text.length;
  let i = 0;
  let inString: '"' | "'" | null = null;

  while (i < n) {
    if (inString !== null) {
      if (text[i] === '\\' && i + 1 < n) { i += 2; continue; }
      if (text[i] === inString || text[i] === '\n') inString = null;
      i++;
      continue;
    }

    if (text[i] === '#') {
      const start = i;
      const nl = text.indexOf('\n', i + 1);
      const end = nl === -1 ? n : nl;
      ranges.push([start, end]);
      i = end;
      continue;
    }

    if (text[i] === '"' || text[i] === "'") {
      inString = text[i] as '"' | "'";
      i++;
      continue;
    }

    i++;
  }

  return ranges;
}

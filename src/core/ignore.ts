import * as fs from 'fs';
import * as path from 'path';

export const SLOPIGNORE_FILENAME = '.slopignore';

type IgnorePattern = {
  raw: string;
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
};

export type IgnoreMatcher = {
  patterns: IgnorePattern[];
  ignores(relPath: string, isDirectory?: boolean): boolean;
};

// Parse .gitignore-style pattern lines into matchers. Blank lines and lines
// starting with `#` are skipped. `!foo` negates; trailing `/` means
// directory-only; a leading `/` or an internal `/` anchors to the root; a bare
// name matches at any depth.
export function parseIgnorePatterns(lines: string[]): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (const rawLine of lines) {
    let line = rawLine.replace(/\r$/, '');
    // Strip unescaped trailing whitespace. `\ ` preserves a trailing space.
    line = line.replace(/(?:^|[^\\])\s+$/, m => {
      const first = m[0];
      return first === ' ' || first === '\t' ? '' : first;
    });
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('\\#')) line = line.slice(1);

    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }

    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    if (line.length === 0) continue;

    let rooted: boolean;
    if (line.startsWith('/')) { rooted = true; line = line.slice(1); }
    else { rooted = line.includes('/'); }

    const regex = globToRegex(line, rooted);
    out.push({ raw: rawLine, negate, dirOnly, regex });
  }
  return out;
}

function escapeRegexChar(c: string): string {
  return /[.+^${}()|[\]\\/]/.test(c) ? '\\' + c : c;
}

function globToRegex(pattern: string, rooted: boolean): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '[') {
      const j = pattern.indexOf(']', i + 1);
      if (j !== -1) { re += pattern.slice(i, j + 1); i = j + 1; continue; }
      re += '\\['; i++; continue;
    }
    if (c === '\\' && i + 1 < pattern.length) {
      re += escapeRegexChar(pattern[i + 1]);
      i += 2;
      continue;
    }
    re += escapeRegexChar(c);
    i++;
  }
  const prefix = rooted ? '^' : '^(?:.*/)?';
  // Trailing "(?:/.*)?$" lets a directory pattern ("docs" or "docs/") match
  // every descendant without a second pass.
  const suffix = '(?:/.*)?$';
  return new RegExp(prefix + re + suffix);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

export function buildIgnoreMatcher(patterns: IgnorePattern[]): IgnoreMatcher {
  return {
    patterns,
    ignores(relPath: string, isDirectory?: boolean): boolean {
      const normalized = toPosix(relPath);
      if (normalized.length === 0) return false;
      let ignored = false;
      for (const p of patterns) {
        if (p.dirOnly && isDirectory === false) continue;
        if (p.regex.test(normalized)) {
          ignored = !p.negate;
        }
      }
      return ignored;
    },
  };
}

export function loadIgnoreMatcher(
  rootDir: string | null,
  extraPatterns: string[] = [],
): IgnoreMatcher {
  const lines: string[] = [];
  if (rootDir !== null) {
    const file = path.join(rootDir, SLOPIGNORE_FILENAME);
    try {
      const text = fs.readFileSync(file, 'utf8');
      lines.push(...text.split(/\r?\n/));
    } catch {
      // No .slopignore present -- fall through to just the extra patterns.
    }
  }
  for (const p of extraPatterns) {
    if (typeof p === 'string') lines.push(p);
  }
  return buildIgnoreMatcher(parseIgnorePatterns(lines));
}

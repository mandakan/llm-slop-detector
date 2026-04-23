import { CharRule, Finding, RuleSet } from './types';
import { getCommentScanner } from './comments';

export type Language = string;

type Range = [number, number];

type Suppression = {
  start: number;
  end: number;
  applies: (code: 'char' | 'phrase', matchText: string, rulePattern?: string) => boolean;
};

export function charDiagnosticMessage(def: CharRule): string {
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

export function scanText(text: string, rules: RuleSet, language: Language): Finding[] {
  const findings: Finding[] = [];
  const excluded = computeExcludedRanges(text, language);
  if (excluded === null) return findings;
  const suppressions = computeSuppressions(text, excluded);

  rules.charRegex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = rules.charRegex.exec(text)) !== null) {
    const def = rules.chars.get(m[0]);
    if (!def) continue;
    if (offsetInRanges(m.index, excluded)) continue;
    if (isSuppressed(m.index, suppressions, 'char', m[0])) continue;
    findings.push({
      offset: m.index,
      length: m[0].length,
      matchText: m[0],
      code: 'char',
      severity: def.severity,
      message: charDiagnosticMessage(def),
      source: def.source,
    });
  }

  for (const p of rules.phrases) {
    p.regex.lastIndex = 0;
    while ((m = p.regex.exec(text)) !== null) {
      if (m[0].length === 0) { p.regex.lastIndex++; continue; }
      if (offsetInRanges(m.index, excluded)) continue;
      if (isSuppressed(m.index, suppressions, 'phrase', m[0], p.pattern)) continue;
      const reasonBit = p.reason ? ` - ${p.reason}` : '';
      findings.push({
        offset: m.index,
        length: m[0].length,
        matchText: m[0],
        code: 'phrase',
        severity: p.severity,
        message: `LLM-style phrase: "${m[0]}"${reasonBit} [${p.source}]`,
        source: p.source,
        rulePattern: p.pattern,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Scope: markdown exclusions, code-comment inclusion, inline ignore directives
// ---------------------------------------------------------------------------

// Returns the ranges that should be SKIPPED during scanning. null means the
// language isn't supported and the file should not be scanned at all.
function computeExcludedRanges(text: string, language: Language): Range[] | null {
  if (language === 'markdown') return computeMarkdownExclusions(text);
  if (language === 'plaintext' || language === 'scminput') return [];
  if (language === 'git-commit') return computeGitCommitExclusions(text);

  const commentScanner = getCommentScanner(language);
  if (commentScanner === null) return null;

  const comments = mergeRanges(commentScanner(text));
  return invertRanges(comments, text.length);
}

// Skip '#' comment lines (stripped by git before commit) and everything after
// the verbose-commit scissors marker ("# ------------------------ >8 ---...").
function computeGitCommitExclusions(text: string): Range[] {
  const ranges: Range[] = [];
  const scissorsRe = /^#\s*-+\s*>8\s*-+/;
  let i = 0;
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    if (scissorsRe.test(line)) {
      ranges.push([i, text.length]);
      break;
    }
    if (line.startsWith('#')) {
      ranges.push([i, nl === -1 ? text.length : nl + 1]);
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  return mergeRanges(ranges);
}

function invertRanges(ranges: Range[], textLen: number): Range[] {
  const inverted: Range[] = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) inverted.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < textLen) inverted.push([cursor, textLen]);
  return inverted;
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return ranges;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [[ranges[0][0], ranges[0][1]]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const curr = ranges[i];
    if (curr[0] <= last[1]) {
      last[1] = Math.max(last[1], curr[1]);
    } else {
      merged.push([curr[0], curr[1]]);
    }
  }
  return merged;
}

function offsetInRanges(offset: number, ranges: Range[]): boolean {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (offset < s) hi = mid - 1;
    else if (offset >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

// Line-based scan for fenced code blocks and YAML frontmatter, plus regex for
// inline code spans and link URLs. Good enough for the 95% case without
// pulling in a CommonMark parser.
function computeMarkdownExclusions(text: string): Range[] {
  const ranges: Range[] = [];

  let i = 0;
  let lineIdx = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = 0;
  let inFrontmatter = false;
  let frontmatterStart = 0;

  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    const nextLineStart = nl === -1 ? text.length : nl + 1;

    if (!inFence) {
      if (lineIdx === 0 && line === '---') {
        inFrontmatter = true;
        frontmatterStart = i;
      } else if (inFrontmatter && (line === '---' || line === '...')) {
        ranges.push([frontmatterStart, nextLineStart]);
        inFrontmatter = false;
      } else if (!inFrontmatter) {
        const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (m) {
          inFence = true;
          fenceChar = m[1][0];
          fenceLen = m[1].length;
          fenceStart = i;
        }
      }
    } else {
      const closer = new RegExp('^ {0,3}' + (fenceChar === '`' ? '`' : '~') + '{' + fenceLen + ',}\\s*$');
      if (closer.test(line)) {
        ranges.push([fenceStart, nextLineStart]);
        inFence = false;
      }
    }

    if (nl === -1) break;
    lineIdx++;
    i = nextLineStart;
  }

  if (inFence) ranges.push([fenceStart, text.length]);

  let m: RegExpExecArray | null;
  const inlineCodeRe = /`[^`\n]+`/g;
  while ((m = inlineCodeRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  const linkRe = /\[[^\]\n]*\]\(([^)\n]+)\)/g;
  while ((m = linkRe.exec(text)) !== null) {
    const parenOpen = m.index + m[0].lastIndexOf('(');
    const parenClose = m.index + m[0].length - 1;
    ranges.push([parenOpen + 1, parenClose]);
  }

  const autolinkRe = /<https?:\/\/[^>\s]+>/gi;
  while ((m = autolinkRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  return mergeRanges(ranges);
}

function parseSuppressionSpecs(raw: string): Suppression['applies'] {
  const specs = raw.trim().split(/\s+/).filter(Boolean);
  if (specs.length === 0) return () => true;

  const phraseSpecs: string[] = [];
  const charSpecs: string[] = [];
  for (const s of specs) {
    if (s.startsWith('phrase:')) phraseSpecs.push(s.slice('phrase:'.length));
    else if (s.startsWith('char:')) charSpecs.push(s.slice('char:'.length));
  }

  return (code, matchText, rulePattern) => {
    if (code === 'phrase') {
      return phraseSpecs.some(p => rulePattern === p);
    }
    return charSpecs.some(c => {
      if (/^u\+/i.test(c)) {
        const cp = parseInt(c.slice(2), 16);
        return !Number.isNaN(cp) && matchText.codePointAt(0) === cp;
      }
      return matchText === c;
    });
  };
}

function computeSuppressions(text: string, excluded: Range[]): Suppression[] {
  const directiveRe = /<!--\s*slop-(disable-next-line|disable-line|disable|enable)\b([^>]*?)-->/gi;
  type Directive = {
    kind: 'disable' | 'enable' | 'disable-next-line' | 'disable-line';
    applies: Suppression['applies'];
    start: number;
    end: number;
  };
  const directives: Directive[] = [];
  let m: RegExpExecArray | null;
  while ((m = directiveRe.exec(text)) !== null) {
    if (offsetInRanges(m.index, excluded)) continue;
    directives.push({
      kind: m[1].toLowerCase() as Directive['kind'],
      applies: parseSuppressionSpecs(m[2] || ''),
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  const result: Suppression[] = [];
  let blockStart: number | null = null;
  let blockApplies: Suppression['applies'] | null = null;

  for (const d of directives) {
    if (d.kind === 'disable') {
      if (blockStart === null) {
        blockStart = d.end;
        blockApplies = d.applies;
      }
    } else if (d.kind === 'enable') {
      if (blockStart !== null && blockApplies !== null) {
        result.push({ start: blockStart, end: d.start, applies: blockApplies });
        blockStart = null;
        blockApplies = null;
      }
    } else if (d.kind === 'disable-line') {
      const lineStart = text.lastIndexOf('\n', d.start - 1) + 1;
      const nl = text.indexOf('\n', d.end);
      const lineEnd = nl === -1 ? text.length : nl;
      result.push({ start: lineStart, end: lineEnd, applies: d.applies });
    } else if (d.kind === 'disable-next-line') {
      const nl = text.indexOf('\n', d.end);
      if (nl === -1) continue;
      const nextLineStart = nl + 1;
      const nextNl = text.indexOf('\n', nextLineStart);
      const nextLineEnd = nextNl === -1 ? text.length : nextNl;
      result.push({ start: nextLineStart, end: nextLineEnd, applies: d.applies });
    }
  }

  if (blockStart !== null && blockApplies !== null) {
    result.push({ start: blockStart, end: text.length, applies: blockApplies });
  }

  return result;
}

function isSuppressed(
  offset: number,
  suppressions: Suppression[],
  code: 'char' | 'phrase',
  matchText: string,
  rulePattern?: string
): boolean {
  for (const s of suppressions) {
    if (offset >= s.start && offset < s.end && s.applies(code, matchText, rulePattern)) {
      return true;
    }
  }
  return false;
}

export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, col: offset - lastNl };
}

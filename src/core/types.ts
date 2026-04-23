export type Severity = 'error' | 'warning' | 'information' | 'hint';

export const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
};

export type CharRule = {
  char: string;
  name: string;
  severity: Severity;
  replacement?: string;
  suggestion?: string;
  source: string;
};

export type PhraseRule = {
  pattern: string;
  regex: RegExp;
  reason?: string;
  severity: Severity;
  source: string;
};

export type RuleSource = {
  name: string;
  version?: string;
  description?: string;
  origin: string;
  charCount: number;
  phraseCount: number;
};

export type RuleSet = {
  chars: Map<string, CharRule>;
  phrases: PhraseRule[];
  sources: RuleSource[];
  charRegex: RegExp;
};

export type Finding = {
  offset: number;
  length: number;
  matchText: string;
  code: 'char' | 'phrase';
  severity: Severity;
  message: string;
  source: string;
  rulePattern?: string;
};

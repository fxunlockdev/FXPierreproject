import type { RelayMessage } from './types';
import type { RouteFilters } from './rules';

export type FilterResult = { pass: true } | { pass: false; reason: string };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchesKeyword(
  text: string,
  keyword: string,
  opts: { caseSensitive: boolean; wholeWord: boolean },
): boolean {
  if (keyword.length === 0) return false;
  if (opts.wholeWord) {
    const re = new RegExp(
      `(^|[^\\p{L}\\p{N}_])${escapeRegex(keyword)}($|[^\\p{L}\\p{N}_])`,
      opts.caseSensitive ? 'u' : 'iu',
    );
    return re.test(text);
  }
  const haystack = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? keyword : keyword.toLowerCase();
  return haystack.includes(needle);
}

/**
 * Static screen for catastrophic-backtracking patterns (ReDoS). Master-channel
 * content is untrusted input, and one crafted post matched against a nested
 * quantifier can freeze the whole single-threaded relay — so risky patterns
 * are rejected up front. Conservative on purpose: a quantified group may not
 * itself contain a quantifier or alternation.
 */
export function regexRiskReason(pattern: string): string | null {
  // Only quantifiers that allow MORE THAN ONE repetition compound
  // backtracking; `?`, `{1}` and `{0,1}` are harmless on a group.
  const repeats = (rest: string): boolean => {
    if (rest.startsWith('*') || rest.startsWith('+')) return true;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(rest);
    if (!m) return false;
    if (m[2] === undefined) return Number(m[1]) >= 2; // {n}
    if (m[3] === undefined || m[3] === '') return true; // {n,}
    return Number(m[3]) >= 2; // {n,m}
  };

  const stack: { hasQuant: boolean; hasAlt: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      stack.push({ hasQuant: false, hasAlt: false });
    } else if (ch === '|' && stack.length > 0) {
      stack[stack.length - 1]!.hasAlt = true;
    } else if (ch === ')') {
      const group = stack.pop();
      if (group && repeats(pattern.slice(i + 1))) {
        if (group.hasQuant) {
          return 'a repeated group must not contain another repetition (e.g. "(a+)+") — it can lock up the relay';
        }
        if (group.hasAlt) {
          return 'a repeated group must not contain "|" — rewrite it so the repetition is inside each branch';
        }
      }
    } else if (
      ch === '*' ||
      ch === '+' ||
      (ch === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)))
    ) {
      for (const g of stack) g.hasQuant = true;
    }
  }
  return null;
}

/** Compile a user-supplied regex defensively; invalid or risky patterns never match. */
export function safeRegex(pattern: string, caseSensitive: boolean): RegExp | null {
  if (pattern.length === 0 || pattern.length > 500) return null;
  if (regexRiskReason(pattern) !== null) return null;
  try {
    return new RegExp(pattern, caseSensitive ? 'u' : 'iu');
  } catch {
    return null;
  }
}

/**
 * Filter order: media type → length → exclude keywords → exclude regex →
 * include keywords → include regex. First failure wins and is reported.
 */
export function checkFilters(msg: RelayMessage, f: RouteFilters): FilterResult {
  if (f.mediaTypes && f.mediaTypes.length > 0 && !f.mediaTypes.includes(msg.media)) {
    return { pass: false, reason: `media type "${msg.media}" not allowed` };
  }

  const text = msg.text.text;
  const opts = { caseSensitive: f.caseSensitive, wholeWord: f.wholeWord };

  if (f.minLength !== undefined && text.length < f.minLength) {
    return { pass: false, reason: `shorter than ${f.minLength} chars` };
  }
  if (f.maxLength !== undefined && text.length > f.maxLength) {
    return { pass: false, reason: `longer than ${f.maxLength} chars` };
  }

  for (const kw of f.excludeKeywords) {
    if (matchesKeyword(text, kw, opts)) {
      return { pass: false, reason: `contains blocked keyword "${kw}"` };
    }
  }

  if (f.excludeRegex) {
    const re = safeRegex(f.excludeRegex, f.caseSensitive);
    if (re?.test(text)) {
      return { pass: false, reason: 'matches blocked pattern' };
    }
  }

  if (f.includeKeywords.length > 0) {
    const hit = f.includeKeywords.some((kw) => matchesKeyword(text, kw, opts));
    if (!hit) return { pass: false, reason: 'no required keyword found' };
  }

  if (f.includeRegex) {
    const re = safeRegex(f.includeRegex, f.caseSensitive);
    if (re && !re.test(text)) {
      return { pass: false, reason: 'required pattern not found' };
    }
  }

  return { pass: true };
}

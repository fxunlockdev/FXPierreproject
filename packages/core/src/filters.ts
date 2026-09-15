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

/** Compile a user-supplied regex defensively; invalid patterns never match. */
export function safeRegex(pattern: string, caseSensitive: boolean): RegExp | null {
  if (pattern.length === 0 || pattern.length > 500) return null;
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

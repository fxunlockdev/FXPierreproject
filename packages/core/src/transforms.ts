import { spliceText, tidyWhitespace } from './richtext';
import { safeRegex } from './filters';
import type { RichText } from './types';
import type { LinkRemoval, Replacement } from './rules';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Range {
  start: number;
  end: number;
  insert: string;
}

/** Apply non-overlapping ranges right-to-left so earlier offsets stay valid. */
function applyRanges(rt: RichText, ranges: Range[]): RichText {
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let out = rt;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const r of sorted) {
    if (r.end > lastStart) continue; // skip overlaps — first (rightmost) wins
    out = spliceText(out, r.start, r.end, r.insert);
    lastStart = r.start;
  }
  return out;
}

/** Ordered find-and-replace list. Formatting entities survive around edits. */
export function applyReplacements(rt: RichText, replacements: Replacement[]): RichText {
  let out = rt;

  for (const rule of replacements) {
    const pattern = rule.regex
      ? safeRegex(rule.find, rule.caseSensitive)
      : new RegExp(escapeRegex(rule.find), rule.caseSensitive ? 'gu' : 'giu');
    if (!pattern) continue;

    const global = pattern.global
      ? pattern
      : new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');

    const ranges: Range[] = [];
    let guard = 0;
    let m = global.exec(out.text);
    while (m !== null && guard < 1000) {
      guard += 1;
      const replacement = rule.regex
        ? m[0].replace(new RegExp(global.source, global.flags.replace('g', '')), rule.replace)
        : rule.replace;
      ranges.push({ start: m.index, end: m.index + m[0].length, insert: replacement });
      if (m[0].length === 0) global.lastIndex += 1; // avoid zero-width loops
      m = global.exec(out.text);
    }

    out = applyRanges(out, ranges);
  }

  return out;
}

const TME_HOSTS = /(^|\.)((t|telegram)\.me|telegram\.org|telegram\.dog)$/i;

function isTelegramUrl(raw: string): boolean {
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return TME_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Strip links per config:
 *  - bare URLs ('url' entities): the URL text itself is removed (or replaced
 *    with the placeholder)
 *  - hidden links ('text_link'): the entity is dropped, the visible text stays
 *  - @mentions and #hashtags: the text is removed
 */
export function applyLinkRemoval(rt: RichText, cfg: LinkRemoval): RichText {
  if (cfg.urls === 'off' && !cfg.mentions && !cfg.hashtags) return rt;

  const ranges: Range[] = [];
  const dropEntityIdx = new Set<number>();

  rt.entities.forEach((e, i) => {
    const slice = rt.text.slice(e.offset, e.offset + e.length);

    if (e.type === 'url' && cfg.urls !== 'off') {
      if (cfg.urls === 'all' || isTelegramUrl(slice)) {
        ranges.push({ start: e.offset, end: e.offset + e.length, insert: cfg.placeholder });
        dropEntityIdx.add(i);
      }
    } else if (e.type === 'text_link' && cfg.urls !== 'off') {
      if (cfg.urls === 'all' || (e.url !== undefined && isTelegramUrl(e.url))) {
        dropEntityIdx.add(i); // unlink: keep the words, lose the hyperlink
      }
    } else if (e.type === 'mention' && cfg.mentions) {
      ranges.push({ start: e.offset, end: e.offset + e.length, insert: '' });
      dropEntityIdx.add(i);
    } else if (e.type === 'hashtag' && cfg.hashtags) {
      ranges.push({ start: e.offset, end: e.offset + e.length, insert: '' });
      dropEntityIdx.add(i);
    }
  });

  // Regex fallback: catch bare URLs/@mentions/#hashtags that carry no entity
  // (entities can be missing after upstream edits, or in simulated messages).
  const covered = (start: number, end: number) =>
    ranges.some((r) => start < r.end && end > r.start);

  if (cfg.urls !== 'off') {
    const urlRe = /(?:https?:\/\/[^\s]+)|(?:\bwww\.[^\s]+)|(?:\bt(?:elegram)?\.me\/[^\s]+)/gi;
    for (const m of rt.text.matchAll(urlRe)) {
      const start = m.index;
      const end = start + m[0].length;
      if (covered(start, end)) continue;
      if (cfg.urls === 'all' || isTelegramUrl(m[0])) {
        ranges.push({ start, end, insert: cfg.placeholder });
      }
    }
  }
  if (cfg.mentions) {
    const mentionRe = /(?:^|(?<=\s))@[a-zA-Z0-9_]{4,32}\b/g;
    for (const m of rt.text.matchAll(mentionRe)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!covered(start, end)) ranges.push({ start, end, insert: '' });
    }
  }
  if (cfg.hashtags) {
    const hashtagRe = /(?:^|(?<=\s))#[\p{L}\p{N}_]+/gu;
    for (const m of rt.text.matchAll(hashtagRe)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!covered(start, end)) ranges.push({ start, end, insert: '' });
    }
  }

  const withoutDropped: RichText = {
    text: rt.text,
    entities: rt.entities.filter((_, i) => !dropEntityIdx.has(i)),
  };

  return tidyWhitespace(applyRanges(withoutDropped, ranges));
}

/** Remove a trailing signature matched by a user regex (anchored to the end). */
export function stripSignature(rt: RichText, pattern: string): RichText {
  if (!pattern) return rt;
  const re = safeRegex(pattern.endsWith('$') ? pattern : `${pattern}\\s*$`, false);
  if (!re) return rt;
  const m = re.exec(rt.text);
  if (!m || m.index === undefined) return rt;
  return tidyWhitespace(spliceText(rt, m.index, rt.text.length, ''));
}

import type { Entity, RichText } from './types';

/**
 * Immutable splice on entity-annotated text. Replaces [start, end) with
 * `insert` and remaps every entity:
 *  - entirely before the splice → unchanged
 *  - entirely after → shifted by the length delta
 *  - containing the splice → stretched/shrunk by the delta
 *  - partially overlapping → clipped to the surviving side
 *  - entirely inside → dropped
 */
export function spliceText(rt: RichText, start: number, end: number, insert: string): RichText {
  const safeStart = Math.max(0, Math.min(start, rt.text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, rt.text.length));
  const delta = insert.length - (safeEnd - safeStart);

  const text = rt.text.slice(0, safeStart) + insert + rt.text.slice(safeEnd);

  const entities: Entity[] = [];
  for (const e of rt.entities) {
    const eStart = e.offset;
    const eEnd = e.offset + e.length;

    if (eEnd <= safeStart) {
      entities.push(e);
    } else if (eStart >= safeEnd) {
      entities.push({ ...e, offset: e.offset + delta });
    } else if (eStart <= safeStart && eEnd >= safeEnd) {
      // entity contains the spliced range
      const next = { ...e, length: e.length + delta };
      if (next.length > 0) entities.push(next);
    } else if (eStart < safeStart && eEnd < safeEnd) {
      // overlaps from the left — keep the left part
      const next = { ...e, length: safeStart - eStart };
      if (next.length > 0) entities.push(next);
    } else if (eStart > safeStart && eEnd > safeEnd) {
      // overlaps from the right — keep the right part
      const next = { ...e, offset: safeStart + insert.length, length: eEnd - safeEnd };
      if (next.length > 0) entities.push(next);
    }
    // else: entity fully inside the replaced range → dropped
  }

  return { text, entities };
}

/** Prepend rich text (with a separator) shifting existing entities. */
export function prependRichText(head: RichText, body: RichText, separator = '\n\n'): RichText {
  if (head.text.length === 0) return body;
  if (body.text.length === 0) return head;
  const shift = head.text.length + separator.length;
  return {
    text: head.text + separator + body.text,
    entities: [
      ...head.entities,
      ...body.entities.map((e) => ({ ...e, offset: e.offset + shift })),
    ],
  };
}

/** Append rich text (with a separator). */
export function appendRichText(body: RichText, tail: RichText, separator = '\n\n'): RichText {
  if (tail.text.length === 0) return body;
  if (body.text.length === 0) return tail;
  const shift = body.text.length + separator.length;
  return {
    text: body.text + separator + tail.text,
    entities: [
      ...body.entities,
      ...tail.entities.map((e) => ({ ...e, offset: e.offset + shift })),
    ],
  };
}

/** Hard cap for Telegram: 4096 for text, 1024 for captions. */
export function truncateRichText(rt: RichText, max: number): RichText {
  if (rt.text.length <= max) return rt;
  const ellipsis = '…';
  return spliceText(rt, Math.max(0, max - ellipsis.length), rt.text.length, ellipsis);
}

/**
 * Tidy whitespace after removals: collapse runs of spaces/tabs left behind,
 * collapse 3+ newlines to 2, and trim the ends. Entity offsets follow along.
 */
export function tidyWhitespace(rt: RichText): RichText {
  let out = rt;

  const patterns: RegExp[] = [
    /[ \t]{2,}/g, // double spaces → single
    /\n{3,}/g, // huge gaps → one blank line
    /[ \t]+\n/g, // trailing spaces before newline
  ];
  const replacements = [' ', '\n\n', '\n'];

  patterns.forEach((pattern, i) => {
    // Re-scan after each change since offsets move.
    let m = pattern.exec(out.text);
    while (m !== null) {
      out = spliceText(out, m.index, m.index + m[0].length, replacements[i]!);
      pattern.lastIndex = m.index + replacements[i]!.length;
      m = pattern.exec(out.text);
    }
    pattern.lastIndex = 0;
  });

  // trim start
  const leading = out.text.match(/^\s+/);
  if (leading) out = spliceText(out, 0, leading[0].length, '');
  // trim end
  const trailing = out.text.match(/\s+$/);
  if (trailing) out = spliceText(out, out.text.length - trailing[0].length, out.text.length, '');

  return out;
}

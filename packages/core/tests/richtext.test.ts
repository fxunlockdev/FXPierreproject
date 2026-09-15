import { describe, expect, it } from 'vitest';
import {
  appendRichText,
  prependRichText,
  richText,
  spliceText,
  tidyWhitespace,
  truncateRichText,
} from '../src/index.js';

describe('spliceText', () => {
  const base = richText('Hello brave new world', [
    { type: 'bold', offset: 0, length: 5 }, // "Hello"
    { type: 'italic', offset: 6, length: 5 }, // "brave"
    { type: 'code', offset: 16, length: 5 }, // "world"
  ]);

  it('keeps entities before the splice and shifts entities after it', () => {
    const out = spliceText(base, 6, 11, 'bold'); // brave → bold
    expect(out.text).toBe('Hello bold new world');
    expect(out.entities).toContainEqual({ type: 'bold', offset: 0, length: 5 });
    expect(out.entities).toContainEqual({ type: 'code', offset: 15, length: 5 });
  });

  it('stretches an entity that contains the splice', () => {
    const out = spliceText(base, 1, 4, 'ELLO-'); // inside "Hello"
    expect(out.text).toBe('HELLO-o brave new world');
    expect(out.entities[0]).toEqual({ type: 'bold', offset: 0, length: 7 });
  });

  it('clips an entity that overlaps from the left', () => {
    const out = spliceText(base, 8, 21, ''); // cuts inside "brave" to the end
    expect(out.text).toBe('Hello br');
    expect(out.entities).toEqual([
      { type: 'bold', offset: 0, length: 5 },
      { type: 'italic', offset: 6, length: 2 },
    ]);
  });

  it('clips an entity that overlaps from the right', () => {
    const out = spliceText(base, 0, 8, 'X'); // removes "Hello br"
    expect(out.text).toBe('Xave new world');
    expect(out.entities).toContainEqual({ type: 'italic', offset: 1, length: 3 });
  });

  it('drops an entity fully inside the replaced range', () => {
    const out = spliceText(base, 5, 12, ' ');
    expect(out.text).toBe('Hello new world');
    expect(out.entities.find((e) => e.type === 'italic')).toBeUndefined();
  });

  it('clamps out-of-bounds ranges', () => {
    const out = spliceText(base, 100, 200, '!');
    expect(out.text).toBe('Hello brave new world!');
  });
});

describe('truncateRichText', () => {
  it('caps text with an ellipsis and clips entities', () => {
    const rt = richText('a'.repeat(50), [{ type: 'bold', offset: 40, length: 10 }]);
    const out = truncateRichText(rt, 20);
    expect(out.text.length).toBe(20);
    expect(out.text.endsWith('…')).toBe(true);
    expect(out.entities).toEqual([]);
  });

  it('leaves short text alone', () => {
    const rt = richText('short');
    expect(truncateRichText(rt, 20)).toEqual(rt);
  });
});

describe('prepend/append', () => {
  it('prepends with separator and shifts body entities', () => {
    const head = richText('HEAD', [{ type: 'bold', offset: 0, length: 4 }]);
    const body = richText('body', [{ type: 'italic', offset: 0, length: 4 }]);
    const out = prependRichText(head, body);
    expect(out.text).toBe('HEAD\n\nbody');
    expect(out.entities).toContainEqual({ type: 'italic', offset: 6, length: 4 });
  });

  it('appends and keeps body entities in place', () => {
    const body = richText('body', [{ type: 'italic', offset: 0, length: 4 }]);
    const tail = richText('TAIL', [{ type: 'bold', offset: 0, length: 4 }]);
    const out = appendRichText(body, tail);
    expect(out.text).toBe('body\n\nTAIL');
    expect(out.entities).toContainEqual({ type: 'bold', offset: 6, length: 4 });
  });

  it('returns the other side when one is empty', () => {
    const body = richText('body');
    expect(prependRichText(richText(''), body)).toEqual(body);
    expect(appendRichText(body, richText(''))).toEqual(body);
  });
});

describe('tidyWhitespace', () => {
  it('collapses gaps left behind by removals', () => {
    const out = tidyWhitespace(richText('  hello   world\n\n\n\nbye  '));
    expect(out.text).toBe('hello world\n\nbye');
  });

  it('keeps entity anchored to its word while collapsing', () => {
    const rt = richText('a   b', [{ type: 'bold', offset: 4, length: 1 }]);
    const out = tidyWhitespace(rt);
    expect(out.text).toBe('a b');
    expect(out.entities).toEqual([{ type: 'bold', offset: 2, length: 1 }]);
  });
});

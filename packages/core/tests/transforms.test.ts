import { describe, expect, it } from 'vitest';
import {
  applyLinkRemoval,
  applyReplacements,
  LinkRemovalSchema,
  richText,
  stripSignature,
} from '../src/index.js';

const link = (input: object) => LinkRemovalSchema.parse(input);

describe('applyReplacements', () => {
  it('replaces plain text case-insensitively by default', () => {
    const out = applyReplacements(richText('Join VIP now, vip only'), [
      { find: 'vip', replace: 'PRO', regex: false, caseSensitive: false },
    ]);
    expect(out.text).toBe('Join PRO now, PRO only');
  });

  it('respects case sensitivity', () => {
    const out = applyReplacements(richText('VIP and vip'), [
      { find: 'vip', replace: 'x', regex: false, caseSensitive: true },
    ]);
    expect(out.text).toBe('VIP and x');
  });

  it('supports regex with capture groups', () => {
    const out = applyReplacements(richText('TP1: 1.0850 TP2: 1.0900'), [
      { find: 'TP(\\d)', replace: 'Target $1', regex: true, caseSensitive: true },
    ]);
    expect(out.text).toBe('Target 1: 1.0850 Target 2: 1.0900');
  });

  it('applies the rule list in order', () => {
    const out = applyReplacements(richText('aaa'), [
      { find: 'aaa', replace: 'bbb', regex: false, caseSensitive: false },
      { find: 'bbb', replace: 'ccc', regex: false, caseSensitive: false },
    ]);
    expect(out.text).toBe('ccc');
  });

  it('keeps surrounding formatting intact', () => {
    const rt = richText('buy EURUSD now', [{ type: 'bold', offset: 0, length: 3 }]);
    const out = applyReplacements(rt, [
      { find: 'EURUSD', replace: 'EUR/USD', regex: false, caseSensitive: false },
    ]);
    expect(out.text).toBe('buy EUR/USD now');
    expect(out.entities).toEqual([{ type: 'bold', offset: 0, length: 3 }]);
  });

  it('ignores invalid regex rules instead of crashing', () => {
    const out = applyReplacements(richText('safe'), [
      { find: '([bad', replace: 'x', regex: true, caseSensitive: false },
    ]);
    expect(out.text).toBe('safe');
  });
});

describe('applyLinkRemoval', () => {
  const sample = richText('Join https://t.me/spamchan and https://example.com @admin #promo', [
    { type: 'url', offset: 5, length: 22 }, // https://t.me/spamchan
    { type: 'url', offset: 32, length: 19 }, // https://example.com
    { type: 'mention', offset: 52, length: 6 }, // @admin
    { type: 'hashtag', offset: 59, length: 6 }, // #promo
  ]);

  it('does nothing when disabled', () => {
    expect(applyLinkRemoval(sample, link({}))).toEqual(sample);
  });

  it('removes only telegram links in tme mode', () => {
    const out = applyLinkRemoval(sample, link({ urls: 'tme' }));
    expect(out.text).not.toContain('t.me');
    expect(out.text).toContain('https://example.com');
  });

  it('removes all bare urls in all mode', () => {
    const out = applyLinkRemoval(sample, link({ urls: 'all' }));
    expect(out.text).not.toContain('http');
  });

  it('uses the placeholder when provided', () => {
    const out = applyLinkRemoval(sample, link({ urls: 'all', placeholder: '[link removed]' }));
    expect(out.text).toContain('[link removed]');
  });

  it('unlinks hidden text links but keeps their words', () => {
    const rt = richText('tap here for more', [
      { type: 'text_link', offset: 4, length: 4, url: 'https://t.me/x' },
    ]);
    const out = applyLinkRemoval(rt, link({ urls: 'tme' }));
    expect(out.text).toBe('tap here for more');
    expect(out.entities).toEqual([]);
  });

  it('keeps non-telegram text links in tme mode', () => {
    const rt = richText('read the docs', [
      { type: 'text_link', offset: 9, length: 4, url: 'https://example.com/docs' },
    ]);
    const out = applyLinkRemoval(rt, link({ urls: 'tme' }));
    expect(out.entities).toHaveLength(1);
  });

  it('removes mentions and hashtags when asked', () => {
    const out = applyLinkRemoval(sample, link({ mentions: true, hashtags: true }));
    expect(out.text).not.toContain('@admin');
    expect(out.text).not.toContain('#promo');
    expect(out.text).toContain('https://example.com');
  });
});

describe('stripSignature', () => {
  it('removes a trailing signature block', () => {
    const out = stripSignature(richText('Signal here\n\n— VIP Team, join us'), '— VIP Team.*');
    expect(out.text).toBe('Signal here');
  });

  it('leaves text alone when the pattern does not match', () => {
    const rt = richText('Signal here');
    expect(stripSignature(rt, 'missing$')).toEqual(rt);
  });

  it('ignores empty and invalid patterns', () => {
    const rt = richText('unchanged');
    expect(stripSignature(rt, '')).toEqual(rt);
    expect(stripSignature(rt, '([broken')).toEqual(rt);
  });
});

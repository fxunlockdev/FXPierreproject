import { describe, expect, it } from 'vitest';
import { expandVariables, parseMiniMarkdown } from '../src/index.js';

describe('parseMiniMarkdown', () => {
  it('parses bold, italic, code and links', () => {
    const out = parseMiniMarkdown('**B** __I__ `C` [go](https://x.io/a)');
    expect(out.text).toBe('B I C go');
    expect(out.entities).toEqual([
      { type: 'bold', offset: 0, length: 1 },
      { type: 'italic', offset: 2, length: 1 },
      { type: 'code', offset: 4, length: 1 },
      { type: 'text_link', offset: 6, length: 2, url: 'https://x.io/a' },
    ]);
  });

  it('passes plain text through untouched', () => {
    const out = parseMiniMarkdown('plain text, no markup');
    expect(out.text).toBe('plain text, no markup');
    expect(out.entities).toEqual([]);
  });

  it('ignores unbalanced markers', () => {
    const out = parseMiniMarkdown('**not closed');
    expect(out.text).toBe('**not closed');
  });
});

describe('expandVariables', () => {
  const now = new Date('2026-09-15T10:30:00Z');

  it('substitutes all variables', () => {
    const out = expandVariables('{master} {master_username} {date} {time} {link}', {
      masterTitle: 'VIP Signals',
      masterUsername: 'vipsig',
      messageLink: 'https://t.me/vipsig/42',
      now,
      tz: 'UTC',
    });
    expect(out).toBe('VIP Signals @vipsig 2026-09-15 10:30 https://t.me/vipsig/42');
  });

  it('renders times in the requested timezone', () => {
    const out = expandVariables('{time}', { masterTitle: 'x', now, tz: 'Europe/Paris' });
    expect(out).toBe('12:30');
  });

  it('handles missing optional variables gracefully', () => {
    const out = expandVariables('[{master_username}] {link}', { masterTitle: 'x', now });
    expect(out).toBe('[] ');
  });

  it('falls back to UTC on a broken timezone', () => {
    const out = expandVariables('{time}', { masterTitle: 'x', now, tz: 'Not/AZone' });
    expect(out).toBe('10:30');
  });
});

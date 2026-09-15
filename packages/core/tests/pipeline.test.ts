import { describe, expect, it } from 'vitest';
import {
  applyRules,
  parseRouteRules,
  richText,
  type PipelineContext,
  type RelayMessage,
} from '../src/index';

const msg = (text: string, media: RelayMessage['media'] = 'text'): RelayMessage => ({
  chatId: '-100999',
  messageId: 7,
  date: 1_789_000_000,
  media,
  text: richText(text),
});

const ctx: PipelineContext = {
  masterTitle: 'Gold Signals',
  masterUsername: 'goldsig',
  messageLink: 'https://t.me/goldsig/7',
  now: new Date('2026-09-15T09:00:00Z'),
  tz: 'UTC',
};

describe('applyRules pipeline', () => {
  it('passes an untouched message with default rules', () => {
    const res = applyRules(msg('XAUUSD buy 2650'), parseRouteRules({}), ctx);
    expect(res).toEqual({
      action: 'pass',
      output: richText('XAUUSD buy 2650'),
      removeButtons: false,
    });
  });

  it('drops on filters before running transforms', () => {
    const rules = parseRouteRules({
      filters: { excludeKeywords: ['promo'] },
      footer: 'should never appear',
    });
    const res = applyRules(msg('big promo today'), rules, ctx);
    expect(res).toEqual({ action: 'drop', reason: 'contains blocked keyword "promo"' });
  });

  it('runs the full transform chain in order', () => {
    const rules = parseRouteRules({
      signatureStrip: '— join .*',
      replacements: [{ find: 'buy', replace: 'BUY' }],
      linkRemoval: { urls: 'all' },
      header: '**{master}**',
      footer: '__{date}__',
    });
    const res = applyRules(
      msg('buy now https://t.me/spam\n\n— join our vip'),
      rules,
      ctx,
    );
    expect(res.action).toBe('pass');
    if (res.action !== 'pass') return;
    expect(res.output.text).toBe('Gold Signals\n\nBUY now\n\n2026-09-15');
    expect(res.output.entities).toContainEqual({ type: 'bold', offset: 0, length: 12 });
    expect(res.output.entities).toContainEqual({ type: 'italic', offset: 23, length: 10 });
  });

  it('caps captions at 1024 chars', () => {
    const res = applyRules(msg('x'.repeat(2000), 'photo'), parseRouteRules({}), ctx);
    expect(res.action).toBe('pass');
    if (res.action !== 'pass') return;
    expect(res.output.text.length).toBe(1024);
  });

  it('caps text at 4096 chars including the footer', () => {
    const res = applyRules(
      msg('x'.repeat(5000)),
      parseRouteRules({ footer: 'tail' }),
      ctx,
    );
    expect(res.action).toBe('pass');
    if (res.action !== 'pass') return;
    expect(res.output.text.length).toBe(4096);
  });

  it('flags button removal for the sender', () => {
    const rules = parseRouteRules({ linkRemoval: { buttons: true } });
    const res = applyRules(msg('with buttons'), rules, ctx);
    expect(res.action === 'pass' && res.removeButtons).toBe(true);
  });

  it('degrades malformed stored rules to defaults instead of crashing', () => {
    const rules = parseRouteRules({ filters: { includeKeywords: 'not-an-array' } });
    const res = applyRules(msg('anything'), rules, ctx);
    expect(res.action).toBe('pass');
  });
});

import { describe, expect, it } from 'vitest';
import { checkFilters, RouteFiltersSchema, richText, type RelayMessage } from '../src/index';

const msg = (text: string, media: RelayMessage['media'] = 'text'): RelayMessage => ({
  chatId: '-100123',
  messageId: 1,
  date: 1_700_000_000,
  media,
  text: richText(text),
});

const filters = (input: object) => RouteFiltersSchema.parse(input);

describe('checkFilters', () => {
  it('passes everything with default filters', () => {
    expect(checkFilters(msg('anything at all'), filters({}))).toEqual({ pass: true });
  });

  it('blocks excluded keywords case-insensitively by default', () => {
    const f = filters({ excludeKeywords: ['spam'] });
    expect(checkFilters(msg('This is SPAM indeed'), f).pass).toBe(false);
    expect(checkFilters(msg('clean message'), f).pass).toBe(true);
  });

  it('respects case sensitivity', () => {
    const f = filters({ excludeKeywords: ['SPAM'], caseSensitive: true });
    expect(checkFilters(msg('lowercase spam'), f).pass).toBe(true);
    expect(checkFilters(msg('real SPAM'), f).pass).toBe(false);
  });

  it('whole-word matching does not hit substrings', () => {
    const f = filters({ includeKeywords: ['buy'], wholeWord: true });
    expect(checkFilters(msg('time to buy now'), f).pass).toBe(true);
    expect(checkFilters(msg('buyer beware'), f).pass).toBe(false);
  });

  it('requires at least one include keyword when set', () => {
    const f = filters({ includeKeywords: ['EURUSD', 'GBPUSD'] });
    expect(checkFilters(msg('EURUSD long @ 1.08'), f).pass).toBe(true);
    const res = checkFilters(msg('USDJPY short'), f);
    expect(res).toEqual({ pass: false, reason: 'no required keyword found' });
  });

  it('applies include and exclude regex', () => {
    const f = filters({ includeRegex: 'TP\\d', excludeRegex: 'demo' });
    expect(checkFilters(msg('Entry 1.1 TP1 1.2'), f).pass).toBe(true);
    expect(checkFilters(msg('Entry only, no targets'), f).pass).toBe(false);
    expect(checkFilters(msg('demo account TP1'), f).pass).toBe(false);
  });

  it('never matches on an invalid user regex', () => {
    const f = filters({ excludeRegex: '([unclosed' });
    expect(checkFilters(msg('anything'), f).pass).toBe(true);
  });

  it('filters by media type', () => {
    const f = filters({ mediaTypes: ['photo', 'video'] });
    expect(checkFilters(msg('caption', 'photo'), f).pass).toBe(true);
    expect(checkFilters(msg('plain', 'text'), f).pass).toBe(false);
  });

  it('applies min and max length', () => {
    const f = filters({ minLength: 5, maxLength: 10 });
    expect(checkFilters(msg('hi'), f).pass).toBe(false);
    expect(checkFilters(msg('just right'), f).pass).toBe(true);
    expect(checkFilters(msg('way too long for this'), f).pass).toBe(false);
  });
});

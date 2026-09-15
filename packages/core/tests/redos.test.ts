import { describe, expect, it } from 'vitest';
import { findRouteRulesProblem, regexRiskReason, safeRegex } from '../src';

describe('regexRiskReason — catastrophic backtracking screen', () => {
  it.each([
    ['(a+)+', 'nested quantifier'],
    ['(\\w*)*', 'nested star'],
    ['(.+){2,}', 'quantified group with inner quantifier'],
    ['(a|aa)+', 'alternation inside a repeated group'],
    ['((ab)*)+', 'nested repeated groups'],
  ])('flags %s (%s)', (pattern) => {
    expect(regexRiskReason(pattern)).not.toBeNull();
    expect(safeRegex(pattern, false)).toBeNull();
  });

  it.each([
    'EURUSD|GBPUSD',
    '\\d+ pips',
    '^BUY (GOLD|SILVER)$',
    'TP\\d?\\s*[:=]\\s*\\d+(\\.\\d+)?',
    't\\.me/\\w+',
    '(SL|TP1|TP2):',
  ])('allows the realistic pattern %s', (pattern) => {
    expect(regexRiskReason(pattern)).toBeNull();
    expect(safeRegex(pattern, false)).not.toBeNull();
  });

  it('ignores quantifiers inside character classes and escapes', () => {
    expect(regexRiskReason('([+*])?x')).toBeNull();
    expect(regexRiskReason('(\\+\\d+)?')).toBeNull();
  });
});

describe('findRouteRulesProblem — save-time validation', () => {
  it('accepts sane rules', () => {
    expect(
      findRouteRulesProblem({
        filters: { excludeRegex: 'promo|discount' },
        replacements: [{ find: 'VIP', replace: 'Premium' }],
        footer: 'via {master}',
      }),
    ).toBeNull();
  });

  it('rejects a risky include regex with a readable message', () => {
    const problem = findRouteRulesProblem({ filters: { includeRegex: '(x+)+$' } });
    expect(problem).toMatch(/include regex/);
  });

  it('rejects a risky regex replacement', () => {
    const problem = findRouteRulesProblem({
      replacements: [{ find: '(a|aa)+', replace: '', regex: true }],
    });
    expect(problem).toMatch(/replacement #1/);
  });

  it('rejects an invalid regex', () => {
    const problem = findRouteRulesProblem({ filters: { excludeRegex: '(unclosed' } });
    expect(problem).toMatch(/exclude regex/);
  });

  it('flags schema violations', () => {
    expect(findRouteRulesProblem({ header: 'x'.repeat(2000) })).toMatch(/header/);
  });
});

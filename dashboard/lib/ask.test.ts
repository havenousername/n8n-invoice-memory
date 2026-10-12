import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH, normalizeQuery, parseOver } from './ask';

describe('normalizeQuery', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeQuery('  GPU   servers\n for  launch ')).toBe('GPU servers for launch');
  });
  it('blank and whitespace-only input is no query', () => {
    expect(normalizeQuery('')).toBeNull();
    expect(normalizeQuery(' \t\n ')).toBeNull();
    expect(normalizeQuery(undefined)).toBeNull();
  });
  it('long input is cut, not rejected', () => {
    const query = normalizeQuery('x'.repeat(5000));
    expect(query).toHaveLength(MAX_QUERY_LENGTH);
  });
});

describe('parseOver', () => {
  it('blank means no threshold', () => {
    expect(parseOver('')).toBeNull();
    expect(parseOver('  ')).toBeNull();
    expect(parseOver(null)).toBeNull();
  });
  it('accepts plain and grouped euro amounts, zero included', () => {
    expect(parseOver('1000')).toBe(1000);
    expect(parseOver('12,000')).toBe(12000);
    expect(parseOver('12 000')).toBe(12000);
    expect(parseOver('0')).toBe(0);
  });
  it('anything else is invalid', () => {
    for (const bad of ['-5', 'abc', '1e9999', '12.5.3', 'NaN']) expect(parseOver(bad), bad).toBe('invalid');
  });
});

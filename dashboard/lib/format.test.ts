import { describe, expect, it } from 'vitest';
import { clock, compactEuro, euro, stageName } from './format';

describe('format', () => {
  it('euros with separators and the sign after', () => {
    expect(euro(132000)).toBe('132,000 €');
    expect(euro(12.3)).toBe('12.30 €');
    expect(euro(null)).toBe('—');
  });
  it('compact euros for tiles', () => {
    expect(compactEuro(1275000)).toBe('1.28 M €');
    expect(compactEuro(48000)).toBe('48 k €');
    expect(compactEuro(950)).toBe('950 €');
  });
  it('clock time in UTC-independent local form', () => {
    expect(clock('2026-10-14T09:05:07Z', 'UTC')).toBe('09:05:07');
  });
  it('stage names', () => {
    expect([0, 1, 2, -1].map(stageName)).toEqual(['received', 'rough read', 'sharp', 'error']);
  });
});

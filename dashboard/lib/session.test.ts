import { describe, expect, it } from 'vitest';
import { SESSION_HOURS, signToken, verifyToken } from './session';

const SECRET = 's'.repeat(32);
const NOW = Date.UTC(2026, 9, 14, 9, 0, 0);

describe('session tokens', () => {
  it('a fresh token verifies', () => {
    expect(verifyToken(SECRET, signToken(SECRET, NOW), NOW + 1000)).toBe(true);
  });
  it('expires after twelve hours', () => {
    const token = signToken(SECRET, NOW);
    expect(SESSION_HOURS).toBe(12);
    expect(verifyToken(SECRET, token, NOW + 12 * 3600_000 - 1)).toBe(true);
    expect(verifyToken(SECRET, token, NOW + 12 * 3600_000 + 1)).toBe(false);
  });
  it('rejects another secret, a forged expiry, and garbage', () => {
    const token = signToken(SECRET, NOW);
    expect(verifyToken('t'.repeat(32), token, NOW)).toBe(false);
    const [, mac] = token.split('.');
    expect(verifyToken(SECRET, `${NOW + 99 * 3600_000}.${mac}`, NOW)).toBe(false);
    for (const bad of ['', 'x', 'a.b.c', `${NOW}.`, undefined]) expect(verifyToken(SECRET, bad, NOW)).toBe(false);
  });
  it('refuses to sign with a short secret', () => {
    expect(() => signToken('short', NOW)).toThrow(/SESSION_SECRET/);
  });
});

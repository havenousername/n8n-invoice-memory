// The passcode session: an HMAC-signed expiry in an httpOnly cookie. Server only.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_HOURS = 12;
export const SESSION_COOKIE = 'q8_session';

function mac(secret: string, expires: string): string {
  return createHmac('sha256', secret).update(expires).digest('hex');
}

export function signToken(secret: string, now: number): string {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const expires = String(now + SESSION_HOURS * 3600_000);
  return `${expires}.${mac(secret, expires)}`;
}

export function verifyToken(secret: string, token: string | undefined, now: number): boolean {
  const parts = (token ?? '').split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^[0-9a-f]{64}$/.test(parts[1])) return false;
  const [expires, given] = parts;
  const expected = Buffer.from(mac(secret, expires), 'hex');
  return timingSafeEqual(expected, Buffer.from(given, 'hex')) && Number(expires) >= now;
}

/** Constant-time passcode check: both sides are hashed first, so lengths never leak. */
export function passcodeMatches(given: string, expected: string): boolean {
  const digest = (s: string) => createHmac('sha256', 'passcode').update(s).digest();
  return expected.length > 0 && timingSafeEqual(digest(given), digest(expected));
}

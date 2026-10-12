import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guarded, readCookie } from './route';
import { ServiceError } from './qdrant';
import { SESSION_COOKIE, signToken } from './session';

const ENV = {
  QDRANT_URL: 'https://q', QDRANT_API_KEY: 'k', N8N_BASE_URL: 'https://n', N8N_DASHBOARD_SECRET: 's',
  DASHBOARD_PASSCODE: 'pass', SESSION_SECRET: 'x'.repeat(32),
};
const saved = { ...process.env };
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => { process.env = { ...saved }; });

const request = (cookie?: string) => new Request('http://localhost/api/offices', { headers: cookie ? { cookie } : {} });
const ok = guarded(async () => Response.json({ fine: true }));

describe('guarded routes', () => {
  it('401 without a session cookie, or with a forged one', async () => {
    expect((await ok(request())).status).toBe(401);
    expect((await ok(request(`${SESSION_COOKIE}=123.abc`))).status).toBe(401);
  });
  it('runs the handler with a valid session', async () => {
    const res = await ok(request(`other=1; ${SESSION_COOKIE}=${signToken(ENV.SESSION_SECRET, Date.now())}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fine: true });
  });
  it('a failing upstream becomes 502 naming the service, without its body', async () => {
    const failing = guarded(async () => { throw new ServiceError('qdrant', 403, 'secret detail'); });
    const res = await failing(request(`${SESSION_COOKIE}=${signToken(ENV.SESSION_SECRET, Date.now())}`));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'qdrant unavailable', status: 403 });
  });
  it('a missing setting is a 500 that names it', async () => {
    delete process.env.QDRANT_URL;
    const res = await ok(request());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/QDRANT_URL/);
  });
});

describe('readCookie', () => {
  it('finds one cookie among several, decoding it', () => {
    expect(readCookie('a=1; q8_session=12.ab%3D; b=2', 'q8_session')).toBe('12.ab=');
    expect(readCookie(null, 'q8_session')).toBeUndefined();
    expect(readCookie('q8_sessionx=1', 'q8_session')).toBeUndefined();
  });
});

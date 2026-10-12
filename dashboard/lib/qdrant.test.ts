import { describe, expect, it } from 'vitest';
import { callN8n, callQdrant, ServiceError } from './qdrant';

const fakeFetch = (status: number, body: string, seen: { url?: string; init?: RequestInit }) =>
  (async (url: string, init: RequestInit) => {
    seen.url = url; seen.init = init;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

describe('callQdrant', () => {
  it('posts JSON with the api-key header and unwraps result', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const result = await callQdrant('/points/scroll', { limit: 1 },
      { url: 'https://cluster.example:6333', apiKey: 'k3y', fetch: fakeFetch(200, '{"result":{"points":[]},"status":"ok"}', seen) });
    expect(result).toEqual({ points: [] });
    expect(seen.url).toBe('https://cluster.example:6333/collections/offices/points/scroll');
    expect(seen.init!.method).toBe('POST');
    expect(new Headers(seen.init!.headers).get('api-key')).toBe('k3y');
    expect(JSON.parse(String(seen.init!.body))).toEqual({ limit: 1 });
  });
  it('a failure carries the status and never the key', async () => {
    const error = (await callQdrant('/points/scroll', {}, { url: 'https://c', apiKey: 'k3y', fetch: fakeFetch(403, '{"status":{"error":"forbidden"}}', {}) })
      .catch((e: unknown) => e)) as ServiceError;
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(403);
    expect(String(error.message)).not.toContain('k3y');
  });
});

describe('callN8n', () => {
  it('posts to the webhook with the dashboard secret header', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const answer = await callN8n('/webhook/send', { file: 'a.pdf' },
      { baseUrl: 'https://n8n.example', secret: 's3cret', fetch: fakeFetch(200, '{"status":"received"}', seen) });
    expect(answer).toEqual({ status: 'received' });
    expect(seen.url).toBe('https://n8n.example/webhook/send');
    expect(new Headers(seen.init!.headers).get('x-dashboard-secret')).toBe('s3cret');
  });
  it('an empty or non-JSON answer is fine; a failure is a ServiceError', async () => {
    expect(await callN8n('/webhook/day/start', {}, { baseUrl: 'https://n', secret: 's', fetch: fakeFetch(200, '', {}) })).toEqual({});
    await expect(callN8n('/webhook/send', {}, { baseUrl: 'https://n', secret: 's', fetch: fakeFetch(403, 'Authorization data is wrong!', {}) }))
      .rejects.toMatchObject({ status: 403 });
  });
});

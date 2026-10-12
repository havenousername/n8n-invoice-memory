// The server's two outbound calls: Qdrant for every read, n8n webhooks for the few writes. Secrets stay here.

export const COLLECTION = 'offices';
export const DASHBOARD_HEADER = 'X-Dashboard-Secret';

export class ServiceError extends Error {
  constructor(public readonly service: 'qdrant' | 'n8n', public readonly status: number, detail: string) {
    super(`${service} answered ${status}: ${detail.slice(0, 300)}`);
  }
}

type QdrantConfig = { url: string; apiKey: string; fetch?: typeof fetch };
type N8nConfig = { baseUrl: string; secret: string; fetch?: typeof fetch };

export async function callQdrant<T = unknown>(path: string, body: unknown, { url, apiKey, fetch: send = fetch }: QdrantConfig): Promise<T> {
  const response = await send(`${url}/collections/${COLLECTION}${path}`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await response.text();
  if (!response.ok) throw new ServiceError('qdrant', response.status, text);
  return (JSON.parse(text) as { result: T }).result;
}

export async function callN8n(path: string, body: unknown, { baseUrl, secret, fetch: send = fetch }: N8nConfig): Promise<unknown> {
  const response = await send(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { [DASHBOARD_HEADER]: secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await response.text();
  if (!response.ok) throw new ServiceError('n8n', response.status, text);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text };
  }
}

/** Server configuration from the environment; a missing value fails loudly at the first request. */
export function serverConfig(env: Record<string, string | undefined> = process.env) {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`missing ${name} in the dashboard environment`);
    return value.replace(/\/$/, '');
  };
  return {
    qdrant: { url: need('QDRANT_URL'), apiKey: need('QDRANT_API_KEY') },
    n8n: { baseUrl: need('N8N_BASE_URL'), secret: need('N8N_DASHBOARD_SECRET') },
    passcode: need('DASHBOARD_PASSCODE'),
    sessionSecret: need('SESSION_SECRET'),
  };
}

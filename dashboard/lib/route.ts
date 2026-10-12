// Every API route but login goes through `guarded`: configuration, the session cookie, and upstream errors.
import { ServiceError, serverConfig } from './qdrant';
import { SESSION_COOKIE, verifyToken } from './session';

export type ServerConfig = ReturnType<typeof serverConfig>;
export const MANAGERS = ['m_anna', 'm_ben'] as const;

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export function guarded(handler: (request: Request, config: ServerConfig) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    let config: ServerConfig;
    try {
      config = serverConfig();
    } catch (error) {
      return json({ error: (error as Error).message }, 500);
    }
    const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    if (!verifyToken(config.sessionSecret, token, Date.now())) return json({ error: 'login required' }, 401);
    try {
      return await handler(request, config);
    } catch (error) {
      if (error instanceof ServiceError) return json({ error: `${error.service} unavailable`, status: error.status }, 502);
      throw error;
    }
  };
}

export function managerFrom(value: string | null): (typeof MANAGERS)[number] | null {
  return MANAGERS.find((m) => m === value) ?? null;
}

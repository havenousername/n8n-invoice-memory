import { json } from '@/lib/route';
import { serverConfig } from '@/lib/qdrant';
import { passcodeMatches, SESSION_COOKIE, SESSION_HOURS, signToken } from '@/lib/session';

// The one open route: the passcode buys a 12-hour httpOnly session cookie.
export async function POST(request: Request) {
  const config = serverConfig();
  const body = (await request.json().catch(() => ({}))) as { passcode?: unknown };
  if (typeof body.passcode !== 'string' || !passcodeMatches(body.passcode, config.passcode)) {
    return json({ error: 'wrong passcode' }, 401);
  }
  const response = json({ ok: true });
  response.headers.append('set-cookie', [
    `${SESSION_COOKIE}=${signToken(config.sessionSecret, Date.now())}`,
    'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_HOURS * 3600}`,
  ].join('; '));
  return response;
}

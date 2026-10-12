import { isPoolFile } from '@/lib/pool';
import { callN8n } from '@/lib/qdrant';
import { guarded, json } from '@/lib/route';

// Send one booth document through 05 Dashboard writes; the answer is 01b's (received or duplicate).
export const POST = guarded(async (request, config) => {
  const { file } = (await request.json().catch(() => ({}))) as { file?: unknown };
  if (!isPoolFile(file)) return json({ error: 'unknown document' }, 400);
  return json(await callN8n('/webhook/send', { file }, config.n8n));
});

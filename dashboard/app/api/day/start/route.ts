import { callN8n } from '@/lib/qdrant';
import { guarded, json } from '@/lib/route';

const MAX_DAY = 40;

// Start the AI working day (00); n8n answers at once and works through the slots on its own.
export const POST = guarded(async (request, config) => {
  const { count } = (await request.json().catch(() => ({}))) as { count?: unknown };
  const slots = Math.min(MAX_DAY, Math.max(1, Math.floor(Number(count)) || 12));
  await callN8n('/webhook/day/start', { count: slots }, config.n8n);
  return json({ running: true, count: slots });
});

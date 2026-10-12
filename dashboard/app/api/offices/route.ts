import { officeList } from '@/lib/bodies';
import { callQdrant } from '@/lib/qdrant';
import { guarded, json, managerFrom } from '@/lib/route';
import { toOfficeCard, type OfficePayload } from '@/lib/shape';

// The poll: one scroll of the manager's shard, straight from Qdrant. No n8n execution is spent on reads.
export const GET = guarded(async (request, config) => {
  const manager = managerFrom(new URL(request.url).searchParams.get('manager'));
  if (!manager) return json({ error: 'unknown manager' }, 400);
  const started = performance.now();
  const { points } = await callQdrant<{ points: { id: string; payload: OfficePayload }[] }>(
    '/points/scroll', officeList(manager), config.qdrant);
  return json({ manager, offices: points.map(toOfficeCard), took_ms: Math.round(performance.now() - started) });
});

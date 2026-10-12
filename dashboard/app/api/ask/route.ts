import { normalizeQuery, parseOver } from '@/lib/ask';
import { askBatch } from '@/lib/bodies';
import { callQdrant } from '@/lib/qdrant';
import { guarded, json, managerFrom } from '@/lib/route';
import { toLensResults } from '@/lib/shape';

// Ask the memory: one batch request, four searches (Keyword, Line, Meaning, fused). No model is called.
export const GET = guarded(async (request, config) => {
  const params = new URL(request.url).searchParams;
  const manager = managerFrom(params.get('manager'));
  const query = normalizeQuery(params.get('q'));
  const over = parseOver(params.get('over'));
  if (!manager) return json({ error: 'unknown manager' }, 400);
  if (!query) return json({ error: 'empty query' }, 400);
  if (over === 'invalid') return json({ error: 'the threshold must be a whole number of euros' }, 400);
  const started = performance.now();
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const batch = await callQdrant<{ points: never[] }[]>('/points/query/batch', askBatch(manager, query, nowIso, 5, over), config.qdrant);
  return json({ manager, query, over, lenses: toLensResults(batch, query), took_ms: Math.round(performance.now() - started), model_calls: 0 });
});

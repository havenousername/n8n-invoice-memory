// Qdrant request bodies. scripts/bodies.py is the reference; bodies.test.ts checks both send the same JSON.

export const MODELS = {
  summary: 'sentence-transformers/all-minilm-l6-v2',
  digest: 'answerdotai/answerai-colbert-small-v1',
  bm25: 'qdrant/bm25',
} as const;
const LENSES = ['bm25', 'digest', 'summary'] as const; // Keyword, Line, Meaning
const DECAY_SCALE_SECONDS = 30 * 24 * 3600;
export const ASK_PAYLOAD = ['office_id', 'name', 'documents', 'summary_text', 'summary_stage'];

type Filter = { must: Record<string, unknown>[] };

function filterFor(manager: string, overGt: number | null): Filter {
  const must: Record<string, unknown>[] = [{ key: 'manager_id', match: { value: manager } }];
  if (overGt !== null) {
    must.push({ nested: { key: 'lines', filter: { must: [{ key: 'over_by', range: { gt: overGt } }] } } });
  }
  return { must };
}

const nearest = (text: string, vector: keyof typeof MODELS) => ({ nearest: { text, model: MODELS[vector] } });

/** POST /collections/offices/points/scroll: the manager's offices, most recently changed first. */
export function officeList(manager: string, overGt: number | null = null, limit = 50) {
  return {
    shard_key: manager,
    limit,
    with_payload: true,
    order_by: { key: 'updated_at', direction: 'desc' },
    filter: filterFor(manager, overGt),
  };
}

/** POST /collections/offices/points/scroll: one office's point. */
export function officeScroll(manager: string, office: string) {
  return {
    shard_key: manager,
    limit: 1,
    with_payload: true,
    filter: { must: [{ key: 'manager_id', match: { value: manager } }, { key: 'office_id', match: { value: office } }] },
  };
}

/** POST /collections/offices/points/query/batch: Keyword, Line, Meaning alone, then the three fused by RRF with decay. */
export function askBatch(manager: string, text: string, nowIso: string, limit = 5, overGt: number | null = null) {
  const filter = filterFor(manager, overGt);
  const singles = LENSES.map((using) => ({
    shard_key: manager, query: nearest(text, using), using, filter, limit, with_payload: ASK_PAYLOAD,
  }));
  const decay = { exp_decay: { x: { datetime_key: 'updated_at' }, target: { datetime: nowIso }, scale: DECAY_SCALE_SECONDS, midpoint: 0.5 } };
  const fused = {
    shard_key: manager,
    prefetch: {
      prefetch: LENSES.map((using) => ({ query: nearest(text, using), using, limit: 20, filter })),
      query: { rrf: {} },
      limit: 20,
    },
    query: { formula: { sum: ['$score', { mult: [0.1, decay] }] } },
    filter,
    limit,
    with_payload: ASK_PAYLOAD,
  };
  return { searches: [...singles, fused] };
}

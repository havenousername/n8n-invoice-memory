import { callN8n } from '@/lib/qdrant';
import { guarded, json } from '@/lib/route';

// Between rehearsals: 07 empties the tables and rebuilds the six offices empty.
export const POST = guarded(async (_request, config) => json(await callN8n('/webhook/reset', {}, config.n8n)));

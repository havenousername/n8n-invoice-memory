import { callN8n } from '@/lib/qdrant';
import { guarded, json } from '@/lib/route';

// Stop the day: the next slot of 00 sees running = false and ends with a reconcile.
export const POST = guarded(async (_request, config) => json(await callN8n('/webhook/day/stop', {}, config.n8n)));

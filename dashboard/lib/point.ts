// What one office point holds, for the point inspector: the payload documents with their status, and the source of
// each vector. The ColBERT lines are rebuilt in exactly the format 03 Rebuild office point embeds
// (workflows/code/office-view.js, digestOf).
import { euro } from './format';
import type { DocumentEntry, OfficeCard } from './shape';

const TYPE_NAMES: Record<string, string> = { cost: 'Commitment', deal: 'Deal', credit: 'Credit note' };

export type PayloadRow = { id: string; label: string; amount: string; status: DocumentEntry['status']; stage: number };
export type Anatomy = { shortId: string; shard: string; rows: PayloadRow[]; digest: string[]; bm25Documents: number };

export function pointAnatomy(card: OfficeCard): Anatomy {
  const names = Object.fromEntries(card.lines.map((l) => [l.category, l.name]));
  const newestFirst = [...card.documents].sort((a, b) => b.received_at.localeCompare(a.received_at));
  return {
    shortId: card.point_id.slice(0, 8),
    shard: card.manager_id,
    rows: newestFirst.map((d) => ({
      id: d.document_id,
      label: d.kind === 'duplicate' || !d.doc_key ? d.filename ?? 'document' : `${d.doc_key} v${d.version ?? '?'}`,
      amount: d.kind === 'duplicate' ? 'same bytes' : euro(d.amount),
      status: d.status,
      stage: d.stage,
    })),
    digest: card.documents.filter((d) => d.status === 'current').map((d) => [
      `${d.doc_key || '?'} v${d.version ?? '?'}`, d.date || '?', TYPE_NAMES[d.doc_type ?? ''] || '?',
      (d.category && names[d.category]) || '-', d.counterparty || '?',
      `${d.amount === null ? '?' : d.amount.toFixed(2)} EUR`, d.description_en || '',
    ].join(' | ')),
    bm25Documents: card.documents.filter((d) => d.kind === 'document').length,
  };
}

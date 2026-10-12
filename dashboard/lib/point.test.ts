import { describe, expect, it } from 'vitest';
import { berlin, doc } from './fixtures';
import { pointAnatomy } from './point';
import { toOfficeCard } from './shape';

const card = toOfficeCard({ id: '3f2a9c1e-0000-4000-8000-000000000000', payload: berlin({ documents: [
  doc({ document_id: 'v1', doc_key: 'PO-1042', version: 1, amount: 48000, status: 'superseded', received_at: '2026-10-14T09:00:00Z' }),
  doc({ document_id: 'copy', kind: 'duplicate', duplicate_of: 'v1', doc_key: null, version: null, amount: null, status: 'duplicate', filename: 'ber-po-1042-v1-copy.pdf', received_at: '2026-10-14T09:01:00Z' }),
  doc({ document_id: 'v2', doc_key: 'PO-1042', version: 2, amount: 132000, received_at: '2026-10-14T09:02:00Z', description_en: 'GPU servers (11x)' }),
] }) });

describe('pointAnatomy', () => {
  it('lists the payload documents newest first with their status', () => {
    const anatomy = pointAnatomy(card);
    expect(anatomy.rows.map((r) => [r.label, r.status])).toEqual([
      ['PO-1042 v2', 'current'], ['ber-po-1042-v1-copy.pdf', 'duplicate'], ['PO-1042 v1', 'superseded'],
    ]);
    expect(anatomy.shortId).toBe('3f2a9c1e');
  });
  it('rebuilds the ColBERT lines exactly as the n8n office view writes them, current documents only', () => {
    expect(pointAnatomy(card).digest).toEqual(['PO-1042 v2 | 2026-10-06 | Commitment | GPU compute | Rechenwerk Systems GmbH | 132000.00 EUR | GPU servers (11x)']);
  });
  it('counts the PDFs whose German text feeds bm25 (every received file but duplicates)', () => {
    expect(pointAnatomy(card).bm25Documents).toBe(2);
  });
});

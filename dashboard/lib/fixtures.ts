// Test fixtures: office payloads shaped as 03 Rebuild office point writes them.
import type { DocumentEntry, OfficePayload } from './shape';

export const line = (category: string, name: string, budget: number, committed: number, credited = 0) => ({
  category, name, budget, committed, credited, remaining: budget - committed, over_by: Math.max(0, committed - budget),
});

export const doc = (fields: Partial<DocumentEntry> & { document_id: string }): DocumentEntry => ({
  kind: 'document', duplicate_of: null, filename: `${fields.document_id}.pdf`, doc_type: 'cost', doc_key: 'PO-1042', version: 1,
  counterparty: 'Rechenwerk Systems GmbH', category: 'gpu', amount: 48000, description_en: 'GPU servers for the inference launch',
  date: '2026-10-06', stage: 2, error: '', received_at: '2026-10-14T09:00:00.000Z', status: 'current', ...fields,
});

export const berlin = (fields: Partial<OfficePayload> = {}): OfficePayload => ({
  office_id: 'berlin', manager_id: 'm_anna', name: 'Berlin', region: 'Central', stage: 2, pending_count: 0,
  lines: [line('people', 'People', 820000, 0), line('cloud', 'Cloud infrastructure', 180000, 160000),
    line('gpu', 'GPU compute', 120000, 132000), line('office', 'Office and facilities', 95000, 0), line('travel', 'Travel and events', 60000, 0)],
  budget: 1275000, committed: 292000, used_pct: 22.9, booked: 0, deal_count: 0,
  documents: [doc({ document_id: 'd1' })], superseded_count: 0, duplicate_count: 0,
  latest: { document_id: 'd1', kind: 'document', doc_type: 'cost', doc_key: 'PO-1042', version: 1, stage: 2, amount: 48000, status: 'current', received_at: '2026-10-14T09:00:00.000Z' },
  source_revision: 'r1', summary_stage: 3, summary_text: 'Berlin is over plan in GPU compute. Cloud is close to its budget.',
  summary_generated_at: '2026-10-14T09:00:10Z', updated_at: '2026-10-14T09:00:10Z', ...fields,
});

// Test fixtures: office payloads shaped as 03 Rebuild office point writes them.
import type { DocumentEntry, OfficePayload } from './shape';

export const line = (category: string, name: string, budget: number, committed: number, credited = 0) => ({
  category, name, budget, committed, credited, remaining: budget - committed, over_by: Math.max(0, committed - budget),
});

export const doc = (fields: Partial<DocumentEntry> & { document_id: string }): DocumentEntry => ({
  kind: 'document', duplicate_of: null, filename: `${fields.document_id}.pdf`, doc_type: 'cost', doc_key: 'PO-1042', version: 1,
  counterparty: 'Lichtwerk Veranstaltungstechnik GmbH', category: 'gpu', amount: 48000, description_en: 'Main stage light and sound, deposit',
  date: '2026-10-06', stage: 2, error: '', received_at: '2026-10-14T09:00:00.000Z', status: 'current', ...fields,
});

export const berlin = (fields: Partial<OfficePayload> = {}): OfficePayload => ({
  office_id: 'berlin', manager_id: 'm_anna', name: 'DevSummit Berlin', region: 'DACH', stage: 2, pending_count: 0,
  lines: [line('people', 'Crew and staffing', 160000, 0), line('cloud', 'Marketing', 90000, 80000),
    line('gpu', 'Stage and AV', 120000, 132000), line('office', 'Venue', 220000, 0), line('travel', 'Catering', 180000, 0)],
  budget: 770000, committed: 212000, used_pct: 27.5, booked: 0, deal_count: 0,
  documents: [doc({ document_id: 'd1' })], superseded_count: 0, duplicate_count: 0,
  latest: { document_id: 'd1', kind: 'document', doc_type: 'cost', doc_key: 'PO-1042', version: 1, stage: 2, amount: 48000, status: 'current', received_at: '2026-10-14T09:00:00.000Z' },
  source_revision: 'r1', summary_stage: 3, summary_text: 'DevSummit Berlin is over plan in Stage and AV. Marketing is close to its budget.',
  summary_generated_at: '2026-10-14T09:00:10Z', updated_at: '2026-10-14T09:00:10Z', ...fields,
});

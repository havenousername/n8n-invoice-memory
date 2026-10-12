// What changed between two polls, as events for the tape and the animations. Only real changes raise events.
import type { DocumentEntry, OfficeCard } from './shape';

export type EventKind = 'received' | 'stage' | 'corrected' | 'superseded' | 'duplicate' | 'summary' | 'error';

export type DashboardEvent = {
  kind: EventKind; office_id: string; office_name: string; at: string;
  document_id?: string; doc_key?: string | null; version?: number | null; filename?: string | null;
  from?: number | null; to?: number | null; error?: string;
};

export function diffOffices(previous: OfficeCard[] | null, next: OfficeCard[]): DashboardEvent[] {
  if (!previous) return [];
  const before = new Map(previous.map((card) => [card.office_id, card]));
  const events: DashboardEvent[] = [];
  for (const card of next) {
    const old = before.get(card.office_id);
    if (!old) continue;
    const oldDocs = new Map(old.documents.map((d) => [d.document_id, d]));
    const base = (d: DocumentEntry) => ({
      office_id: card.office_id, office_name: card.name, at: d.received_at,
      document_id: d.document_id, doc_key: d.doc_key, version: d.version, filename: d.filename,
    });
    for (const d of card.documents) {
      const was = oldDocs.get(d.document_id);
      if (!was) {
        events.push({ ...base(d), kind: d.kind === 'duplicate' ? 'duplicate' : 'received' });
        continue;
      }
      if (d.status === 'superseded' && was.status !== 'superseded') events.push({ ...base(d), kind: 'superseded' });
      if (d.stage === was.stage) continue;
      if (d.stage === -1) {
        events.push({ ...base(d), kind: 'error', error: d.error });
        continue;
      }
      events.push({ ...base(d), kind: 'stage', from: was.stage, to: d.stage });
      if (was.stage === 1 && d.stage === 2 && was.amount !== d.amount) {
        events.push({ ...base(d), kind: 'corrected', from: was.amount, to: d.amount });
      }
    }
    if (card.summary_stage === 3 && (old.summary_stage !== 3 || old.summary_text !== card.summary_text)) {
      events.push({ kind: 'summary', office_id: card.office_id, office_name: card.name, at: card.summary_generated_at });
    }
  }
  return events;
}

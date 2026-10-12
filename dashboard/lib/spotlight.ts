// The first tile of the office map: whatever needs eyes now. A failed read, then a document being read, then a
// fresh duplicate or amendment, then the latest document; idle when nothing has arrived yet.
import type { DashboardEvent } from './events';
import type { DocumentEntry, OfficeCard } from './shape';

export const ATTENTION_MS = 45_000;

export type SeenEvent = DashboardEvent & { seenAt: number };

export type Spotlight =
  | { kind: 'error' | 'running'; office: OfficeCard; document: DocumentEntry }
  | { kind: 'attention'; reason: 'duplicate' | 'superseded'; office: OfficeCard; document: DocumentEntry }
  | { kind: 'latest'; office: OfficeCard; document: DocumentEntry; overPlan: boolean }
  | { kind: 'idle' };

const newest = <T extends { document: DocumentEntry }>(found: T[]) =>
  found.sort((a, b) => b.document.received_at.localeCompare(a.document.received_at))[0];

export function pickSpotlight(cards: OfficeCard[], recent: SeenEvent[], now: number): Spotlight {
  const all = cards.flatMap((office) => office.documents.map((document) => ({ office, document })));

  const failed = newest(all.filter(({ document }) => document.stage === -1));
  if (failed) return { kind: 'error', ...failed };

  const running = newest(all.filter(({ document }) => document.kind === 'document' && (document.stage === 0 || document.stage === 1)));
  if (running) return { kind: 'running', ...running };

  const attention = recent
    .filter((e) => (e.kind === 'duplicate' || e.kind === 'superseded') && now - e.seenAt < ATTENTION_MS)
    .sort((a, b) => b.seenAt - a.seenAt)
    .map((e) => ({ e, found: all.find(({ document }) => document.document_id === e.document_id) }))
    .find(({ found }) => found);
  if (attention?.found) {
    return { kind: 'attention', reason: attention.e.kind as 'duplicate' | 'superseded', ...attention.found };
  }

  const latest = newest([...all]);
  if (!latest) return { kind: 'idle' };
  const line = latest.office.lines.find((l) => l.category === latest.document.category);
  return { kind: 'latest', ...latest, overPlan: line?.status === 'over' };
}

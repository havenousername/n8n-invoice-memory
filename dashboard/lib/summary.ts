// Where an office's cached summary stands. While it is updating, the old summary keeps being served from memory:
// stale-while-revalidate, shown on screen.
import type { OfficeCard } from './shape';

/** After the last document arrives, 02b normally rewrites the summary within seconds; longer means nothing is coming. */
export const WRITE_WINDOW_MS = 120_000;

export type SummaryStatus = { state: 'current' | 'updating' | 'stale' | 'empty'; label: string };

export function summaryStatus(card: OfficeCard, now: number): SummaryStatus {
  const documents = card.documents.filter((d) => d.kind === 'document');
  if (!documents.length) return { state: 'empty', label: 'no documents yet' };
  if (card.pending_count > 0) {
    return { state: 'updating', label: `updating · reading ${card.pending_count} ${card.pending_count === 1 ? 'document' : 'documents'}` };
  }
  if (card.summary_stage === 3) return { state: 'current', label: 'written once · served from memory' };
  if (documents.some((d) => d.stage === -1)) return { state: 'stale', label: 'out of date · a document could not be read' };
  const last = Math.max(...documents.map((d) => Date.parse(d.received_at)));
  return now - last < WRITE_WINDOW_MS
    ? { state: 'updating', label: 'updating · writing the summary' }
    : { state: 'stale', label: 'out of date · rewrites with the next document' };
}

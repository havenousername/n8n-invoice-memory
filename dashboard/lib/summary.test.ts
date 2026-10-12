import { describe, expect, it } from 'vitest';
import { berlin, doc } from './fixtures';
import { toOfficeCard, type OfficePayload } from './shape';
import { summaryStatus, WRITE_WINDOW_MS } from './summary';

const NOW = Date.parse('2026-10-14T09:10:00Z');
const card = (fields: Partial<OfficePayload>) => toOfficeCard({ id: 'p', payload: berlin(fields) });
const recent = new Date(NOW - 20_000).toISOString();
const old = new Date(NOW - WRITE_WINDOW_MS - 1000).toISOString();

describe('summaryStatus', () => {
  it('current: written by the model and cached', () => {
    expect(summaryStatus(card({ summary_stage: 3 }), NOW)).toEqual({ state: 'current', label: 'written once · served from memory' });
  });
  it('updating while documents are still being read', () => {
    expect(summaryStatus(card({ summary_stage: 1, pending_count: 2, stage: 1 }), NOW))
      .toEqual({ state: 'updating', label: 'updating · reading 2 documents' });
    expect(summaryStatus(card({ summary_stage: 3, pending_count: 1, stage: 0 }), NOW).label).toBe('updating · reading 1 document');
  });
  it('updating while the summary is written after the last read', () => {
    const c = card({ summary_stage: 1, pending_count: 0, stage: 2, documents: [doc({ document_id: 'a', received_at: recent })] });
    expect(summaryStatus(c, NOW)).toEqual({ state: 'updating', label: 'updating · writing the summary' });
  });
  it('out of date when nothing has rewritten it for a while', () => {
    const c = card({ summary_stage: 1, pending_count: 0, stage: 2, documents: [doc({ document_id: 'a', received_at: old })] });
    expect(summaryStatus(c, NOW)).toEqual({ state: 'stale', label: 'out of date · rewrites with the next document' });
  });
  it('out of date when a failed read blocks the summary', () => {
    const c = card({ summary_stage: 1, pending_count: 0, stage: 1, documents: [doc({ document_id: 'a', stage: -1, received_at: recent })] });
    expect(summaryStatus(c, NOW)).toEqual({ state: 'stale', label: 'out of date · a document could not be read' });
  });
  it('an office without documents has nothing to summarize', () => {
    expect(summaryStatus(card({ documents: [], summary_stage: 1, stage: 0 }), NOW)).toEqual({ state: 'empty', label: 'no documents yet' });
  });
});

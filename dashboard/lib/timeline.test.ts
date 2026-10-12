import { describe, expect, it } from 'vitest';
import { berlin, doc, line } from './fixtures';
import { toOfficeCard, type OfficePayload } from './shape';
import { officeTimeline } from './timeline';

const T0 = Date.parse('2026-10-14T09:00:00Z');
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const office = (documents: OfficePayload['documents']) => toOfficeCard({ id: 'b', payload: berlin({
  budget: 1_275_000,
  lines: [line('people', 'People', 820000, 0), line('cloud', 'Cloud infrastructure', 180000, 0),
    line('gpu', 'GPU compute', 120000, 0), line('office', 'Office and facilities', 95000, 0), line('travel', 'Travel and events', 60000, 0)],
  documents,
}) });

describe('officeTimeline', () => {
  it('starts at zero and steps up with each commitment', () => {
    const points = officeTimeline(office([
      doc({ document_id: 'a', doc_key: 'PO-1', category: 'cloud', amount: 20000, received_at: at(1) }),
      doc({ document_id: 'b', doc_key: 'PO-2', category: 'gpu', amount: 48000, received_at: at(2) }),
    ]), T0);
    expect(points.map((p) => [p.kind, p.committed])).toEqual([['start', 0], ['commit', 20000], ['commit', 68000]]);
    expect(points[2].pct).toBeCloseTo((68000 / 1_275_000) * 100);
    expect(points[0].t).toBe(T0);
  });

  it('an amendment replaces its older version instead of adding to it, and can push a category over plan', () => {
    const points = officeTimeline(office([
      doc({ document_id: 'v1', doc_key: 'PO-1042', version: 1, amount: 48000, received_at: at(1), status: 'superseded' }),
      doc({ document_id: 'v2', doc_key: 'PO-1042', version: 2, amount: 132000, received_at: at(5) }),
    ]), T0);
    expect(points.slice(1).map((p) => [p.kind, p.committed, p.over])).toEqual([['commit', 48000, false], ['amend', 132000, true]]);
    expect(points[2].label).toBe('PO-1042 v2 replaces v1: 132,000 €, GPU compute over plan');
  });

  it('a duplicate and a deal leave the line flat; a late older version changes nothing', () => {
    const points = officeTimeline(office([
      doc({ document_id: 'v2', doc_key: 'PO-1042', version: 2, amount: 100000, received_at: at(1) }),
      doc({ document_id: 'copy', kind: 'duplicate', duplicate_of: 'v2', doc_key: null, amount: null, status: 'duplicate', received_at: at(2) }),
      doc({ document_id: 'deal', doc_type: 'deal', doc_key: 'DEAL-6000', category: null, amount: 300000, received_at: at(3) }),
      doc({ document_id: 'v1', doc_key: 'PO-1042', version: 1, amount: 48000, received_at: at(4), status: 'superseded' }),
    ]), T0);
    expect(points.slice(1).map((p) => [p.kind, p.committed])).toEqual([['commit', 100000], ['duplicate', 100000], ['deal', 100000], ['late', 100000]]);
  });

  it('a credit note gives budget back, never below zero for its category', () => {
    const points = officeTimeline(office([
      doc({ document_id: 'c', doc_key: 'PO-5', category: 'cloud', amount: 20000, received_at: at(1) }),
      doc({ document_id: 'cn', doc_key: 'CN-7', doc_type: 'credit', category: 'cloud', amount: 25000, received_at: at(2) }),
    ]), T0);
    expect(points.slice(1).map((p) => [p.kind, p.committed])).toEqual([['commit', 20000], ['credit', 0]]);
  });

  it('documents not read yet are not on the line', () => {
    const points = officeTimeline(office([doc({ document_id: 'new', stage: 0, status: 'pending', doc_key: null, amount: null, received_at: at(1) })]), T0);
    expect(points).toHaveLength(1);
  });
});

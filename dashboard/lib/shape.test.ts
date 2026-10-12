import { describe, expect, it } from 'vitest';
import { berlin, doc } from './fixtures';
import { latestAcross, matchedLine, toLensResults, toOfficeCard } from './shape';

describe('toOfficeCard', () => {
  it('rates every line: over plan, near plan from 85%, within plan otherwise', () => {
    const card = toOfficeCard({ id: 'p1', payload: berlin() });
    const status = Object.fromEntries(card.lines.map((l) => [l.category, l.status]));
    expect(status).toEqual({ people: 'within', cloud: 'near', gpu: 'over', office: 'within', travel: 'within' });
    expect(card.lines.find((l) => l.category === 'gpu')!.used).toBeCloseTo(1.1);
    expect(card.over_count).toBe(1);
  });
  it('keeps what the views need and drops nothing they read', () => {
    const card = toOfficeCard({ id: 'p1', payload: berlin() });
    expect(card).toMatchObject({ point_id: 'p1', office_id: 'berlin', name: 'Berlin', manager_id: 'm_anna', stage: 2, summary_stage: 3 });
    expect(card.documents).toHaveLength(1);
  });
  it('a zero budget line is never near plan by division', () => {
    const payload = berlin();
    payload.lines[0] = { ...payload.lines[0], budget: 0, committed: 0, remaining: 0 };
    expect(toOfficeCard({ id: 'p', payload }).lines[0]).toMatchObject({ status: 'within', used: 0 });
  });
});

describe('matchedLine', () => {
  it('picks the document line sharing the most words with the query', () => {
    const payload = berlin({ documents: [
      doc({ document_id: 'a', doc_key: 'PO-2041', counterparty: 'Hetzner Online GmbH', description_en: 'Dedicated servers for staging' }),
      doc({ document_id: 'b', doc_key: 'PO-1042', description_en: 'GPU servers for the inference launch' }),
    ] });
    expect(matchedLine(payload, 'gpu servers launch')).toBe('PO-1042 · Rechenwerk Systems GmbH · GPU servers for the inference launch');
    expect(matchedLine(payload, 'PO-2041')).toMatch(/^PO-2041/);
  });
  it('falls back to a summary sentence, then to nothing', () => {
    expect(matchedLine(berlin({ documents: [] }), 'cloud budget')).toBe('Cloud is close to its budget.');
    expect(matchedLine(berlin({ documents: [] }), 'zzz')).toBeNull();
  });
  it('skips superseded and duplicate documents', () => {
    const payload = berlin({ summary_text: '', documents: [doc({ document_id: 'old', status: 'superseded', description_en: 'old order' })] });
    expect(matchedLine(payload, 'old order')).toBeNull();
  });
});

describe('toLensResults', () => {
  const hit = (office: string, score: number) => ({ id: office, score, payload: berlin({ office_id: office, name: office.toUpperCase() }) });
  it('maps the four searches to keyword, line, meaning, fused', () => {
    const response = [{ points: [hit('berlin', 9.1)] }, { points: [hit('munich', 0.8)] }, { points: [] }, { points: [hit('berlin', 0.5), hit('munich', 0.33)] }];
    const lenses = toLensResults(response, 'gpu servers');
    expect(Object.keys(lenses)).toEqual(['keyword', 'line', 'meaning', 'fused']);
    expect(lenses.keyword).toEqual([{ office_id: 'berlin', name: 'BERLIN', score: 9.1, matched: expect.stringContaining('GPU servers') }]);
    expect(lenses.meaning).toEqual([]);
    expect(lenses.fused.map((h) => h.office_id)).toEqual(['berlin', 'munich']);
  });
  it('a short response is an error, not a silent empty lens', () => {
    expect(() => toLensResults([{ points: [] }], 'x')).toThrow(/four searches/);
  });
});

describe('latestAcross', () => {
  it('finds the newest document of any office, with its office', () => {
    const a = toOfficeCard({ id: 'a', payload: berlin() });
    const b = toOfficeCard({ id: 'b', payload: berlin({ office_id: 'munich', name: 'Munich', latest: { ...berlin().latest!, doc_key: 'PO-2041', received_at: '2026-10-14T10:00:00.000Z' } }) });
    expect(latestAcross([a, b])).toMatchObject({ office_id: 'munich', office_name: 'Munich', doc_key: 'PO-2041' });
    expect(latestAcross([toOfficeCard({ id: 'c', payload: berlin({ latest: null }) })])).toBeNull();
  });
});

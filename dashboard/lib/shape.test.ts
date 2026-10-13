import { describe, expect, it } from 'vitest';
import { berlin, doc } from './fixtures';
import { latestAcross, matchedDocument, matchedSentence, toLensResults, toOfficeCard } from './shape';

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
    expect(card).toMatchObject({ point_id: 'p1', office_id: 'berlin', name: 'DevSummit Berlin', manager_id: 'm_anna', stage: 2, summary_stage: 3 });
    expect(card.documents).toHaveLength(1);
  });
  it('a zero budget line is never near plan by division', () => {
    const payload = berlin();
    payload.lines[0] = { ...payload.lines[0], budget: 0, committed: 0, remaining: 0 };
    expect(toOfficeCard({ id: 'p', payload }).lines[0]).toMatchObject({ status: 'within', used: 0 });
  });
});

describe('matchedDocument', () => {
  const payload = berlin({ documents: [
    doc({ document_id: 'a', doc_key: 'PO-2041', counterparty: 'Isar Catering GmbH', description_en: 'Catering for conference day 1, 300 guests' }),
    doc({ document_id: 'b', doc_key: 'PO-1042', version: 2, description_en: 'Main stage expanded: two LED walls and a second stage for the sponsor keynote track' }),
  ] });
  it('picks the current document sharing the most words, and says which words', () => {
    expect(matchedDocument(payload, 'stage expanded for the keynote track')).toEqual({
      text: 'PO-1042 v2 · Lichtwerk Veranstaltungstechnik GmbH · Main stage expanded: two LED walls and a second stage for the sponsor keynote track',
      words: ['stage', 'expanded', 'keynote', 'track'],
    });
    expect(matchedDocument(payload, 'PO-2041')?.text).toMatch(/^PO-2041 v1 · Isar Catering/);
  });
  it('filler words never count as a match', () => {
    expect(matchedDocument(payload, 'for the')).toBeNull();
  });
  it('never answers from superseded or duplicate documents, or from nothing', () => {
    const old = berlin({ documents: [doc({ document_id: 'old', status: 'superseded', description_en: 'old order' })] });
    expect(matchedDocument(old, 'old order')).toBeNull();
    expect(matchedDocument(payload, 'zzz')).toBeNull();
  });
});

describe('matchedSentence', () => {
  it('picks the summary sentence closest to the question, else the first sentence', () => {
    expect(matchedSentence(berlin(), 'marketing budget')).toBe('Marketing is close to its budget.');
    expect(matchedSentence(berlin(), 'zzz')).toBe('DevSummit Berlin is over plan in Stage and AV.');
    expect(matchedSentence(berlin({ summary_text: '' }), 'x')).toBeNull();
  });
});

describe('toLensResults', () => {
  const hit = (office: string, score: number) => ({ id: office, score, payload: berlin({ office_id: office, name: office.toUpperCase() }) });
  it('maps the four searches to keyword, line, meaning, fused', () => {
    const response = [{ points: [hit('berlin', 9.1)] }, { points: [hit('munich', 0.8)] }, { points: [] }, { points: [hit('berlin', 0.5), hit('munich', 0.33)] }];
    const lenses = toLensResults(response, 'stage light');
    expect(Object.keys(lenses)).toEqual(['keyword', 'line', 'meaning', 'fused']);
    expect(lenses.keyword).toEqual([{ office_id: 'berlin', name: 'BERLIN', score: 9.1,
      document: { text: expect.stringContaining('stage light'), words: ['stage', 'light'] }, sentence: 'DevSummit Berlin is over plan in Stage and AV.' }]);
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

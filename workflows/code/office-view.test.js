const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { computeOfficeView } = require('./office-view');

const NOW = '2026-10-12T10:00:00Z';
const BERLIN = { office_id: 'berlin', manager_id: 'm_anna', name: 'Berlin', region: 'Central', narrative: '', narrative_at: '', narrative_revision: '' };
const BUDGETS = { people: 820000, cloud: 180000, gpu: 120000, office: 95000, travel: 60000 };

let seq = 0;
// A documents row as 02 Process leaves it. Fields are what was read: llm at stage 2, regex at stage 1 or -1.
function row({ stage = 2, key = 'PO-5000', type = 'cost', version = 1, category = 'gpu', amount = 1000, at, kind = 'document', duplicate_of = '', error = '', text = 'raw text' } = {}) {
  seq += 1;
  const fields = { doc_type: type, doc_key: key, version, cost_center: 'CC-BER-01', date: '2026-10-06', counterparty: 'Rechenwerk Systems GmbH',
    category: type === 'deal' ? null : category, amount, description_en: `${key} description` };
  return {
    document_id: `doc_${seq}`, kind, duplicate_of, office_id: 'berlin', manager_id: 'm_anna', worker_id: 'w_tom',
    filename: `ber-${key.toLowerCase()}-v${version}.pdf`, text, stage, error,
    regex_fields: stage === 0 ? '{}' : JSON.stringify({ ...fields, amount: amount / 1000 }),
    llm_fields: stage >= 2 ? JSON.stringify(fields) : '{}',
    received_at: at || `2026-10-12T09:${String(seq % 60).padStart(2, '0')}:00Z`,
  };
}
const view = (rows, office = BERLIN) => computeOfficeView(office, rows, BUDGETS, NOW);
const line = (payload, category) => payload.lines.find((l) => l.category === category);

test('a Berlin day sums costs per category against the budget', () => {
  const { payload } = view([
    row({ key: 'PO-5000', category: 'gpu', amount: 90000 }),
    row({ key: 'PO-5001', category: 'gpu', amount: 40000 }),
    row({ key: 'PO-5002', category: 'travel', amount: 12000 }),
  ]);
  assert.deepEqual(line(payload, 'gpu'), { category: 'gpu', name: 'GPU compute', budget: 120000, committed: 130000, credited: 0, remaining: -10000, over_by: 10000 });
  assert.equal(line(payload, 'travel').remaining, 48000);
  assert.deepEqual(payload.lines.map((l) => l.category), ['people', 'cloud', 'gpu', 'office', 'travel']);
  assert.equal(payload.budget, 1275000);
  assert.equal(payload.committed, 142000);
  assert.equal(payload.used_pct, 11.1);
  assert.equal(payload.stage, 2);
});

test('an amendment supersedes version 1', () => {
  const { payload } = view([row({ key: 'PO-1042', version: 1, amount: 48000 }), row({ key: 'PO-1042', version: 2, amount: 132000 })]);
  assert.equal(line(payload, 'gpu').committed, 132000);
  assert.equal(payload.superseded_count, 1);
  assert.deepEqual(payload.documents.map((d) => [d.version, d.status]), [[1, 'superseded'], [2, 'current']]);
});

test('late older version: an older version arriving later never becomes current', () => {
  const v2 = row({ key: 'PO-1042', version: 2, amount: 132000, at: '2026-10-12T09:00:00Z' });
  const v1 = row({ key: 'PO-1042', version: 1, amount: 48000, at: '2026-10-12T09:30:00Z' });
  assert.equal(line(view([v2, v1]).payload, 'gpu').committed, 132000);
  const pendingV1 = row({ key: 'PO-1042', version: 1, stage: 0, at: '2026-10-12T08:00:00Z' });
  assert.equal(line(view([v2, pendingV1]).payload, 'gpu').committed, 132000);
});

test('credit larger than committed: committed stays at zero', () => {
  const { payload } = view([
    row({ key: 'PO-5001', category: 'cloud', amount: 20000 }),
    row({ key: 'CN-7000', type: 'credit', category: 'cloud', amount: 25000 }),
  ]);
  assert.deepEqual(line(payload, 'cloud'), { category: 'cloud', name: 'Cloud infrastructure', budget: 180000, committed: 0, credited: 25000, remaining: 180000, over_by: 0 });
});

test('deals are booked, not committed', () => {
  const { payload } = view([row({ key: 'DEAL-6000', type: 'deal', amount: 300000 })]);
  assert.equal(payload.booked, 300000);
  assert.equal(payload.deal_count, 1);
  assert.equal(payload.committed, 0);
});

test('a duplicate of an amended document is counted and never summed', () => {
  const v1 = row({ key: 'PO-1042', version: 1, amount: 48000 });
  const copy = row({ kind: 'duplicate', duplicate_of: v1.filename, stage: 0 });
  const before = view([v1, copy]).payload;
  assert.equal(line(before, 'gpu').committed, 48000);
  const after = view([v1, copy, row({ key: 'PO-1042', version: 2, amount: 132000 })]).payload;
  assert.equal(line(after, 'gpu').committed, 132000);
  assert.equal(after.duplicate_count, 1);
  assert.equal(after.documents.find((d) => d.kind === 'duplicate').status, 'duplicate');
  assert.equal(after.stage, 2, 'a duplicate never holds the stage back');
});

test('a pending row holds the stage at 0', () => {
  const { payload } = view([row({}), row({ key: 'PO-5009', stage: 0 })]);
  assert.equal(payload.stage, 0);
  assert.equal(payload.pending_count, 1);
  assert.equal(payload.documents.find((d) => d.stage === 0).status, 'pending');
});

test('a rough row counts with its naive amount and holds the stage at 1', () => {
  const { payload } = view([row({ key: 'PO-5003', stage: 1, category: 'cloud', amount: 12300 })]);
  assert.equal(line(payload, 'cloud').committed, 12.3);
  assert.equal(payload.stage, 1);
  assert.equal(payload.pending_count, 1);
});

test('an error row counts as rough, keeps its error, and is not pending', () => {
  const { payload } = view([row({ key: 'PO-5004', stage: -1, error: 'vision timeout', category: 'cloud', amount: 5000 })]);
  assert.equal(payload.stage, 1);
  assert.equal(payload.pending_count, 0);
  assert.equal(payload.documents[0].error, 'vision timeout');
});

test('the summary is fresh only for the rows it was written from', () => {
  const v1 = row({ key: 'PO-1042', version: 1, amount: 48000 });
  const revision = view([v1]).payload.source_revision;
  const office = { ...BERLIN, narrative: 'Berlin committed 48,000 EUR on GPU servers.', narrative_revision: revision, narrative_at: '2026-10-12T09:59:00Z' };
  const fresh = view([v1], office).payload;
  assert.equal(fresh.summary_stage, 3);
  assert.equal(fresh.summary_text, office.narrative);
  const amended = view([v1, row({ key: 'PO-1042', version: 2, amount: 132000 })], office).payload;
  assert.equal(amended.summary_stage, 1, 'an amendment makes the summary stale');
  assert.match(amended.summary_text, /committed/);
});

test('texts: one digest line per current document, raw text plus descriptions for keywords', () => {
  const { texts } = view([
    row({ key: 'PO-1042', version: 1, amount: 48000, text: 'Belegnummer: PO-1042 alt' }),
    row({ key: 'PO-1042', version: 2, amount: 132000, text: 'Belegnummer: PO-1042 neu' }),
  ]);
  assert.deepEqual(texts.digest.split('\n'), ['PO-1042 v2 | 2026-10-06 | Commitment | GPU compute | Rechenwerk Systems GmbH | 132000.00 EUR | PO-1042 description']);
  assert.match(texts.bm25, /PO-1042 alt/);
  assert.match(texts.bm25, /PO-1042 neu/);
  assert.match(texts.bm25, /PO-1042 description/);
});

test('an office with no rows gives zeros and a valid view', () => {
  const { payload, texts } = view([]);
  assert.equal(payload.stage, 0);
  assert.equal(payload.committed, 0);
  assert.equal(payload.latest, null);
  assert.equal(texts.digest, 'no documents');
  assert.equal(texts.bm25, 'no text');
});

test('the newest row of any kind is latest', () => {
  const copy = row({ kind: 'duplicate', duplicate_of: 'x.pdf', stage: 0, at: '2026-10-12T09:59:59Z' });
  assert.equal(view([row({ at: '2026-10-12T09:00:00Z' }), copy]).payload.latest.document_id, copy.document_id);
});

test('cross-check: the same day gives the same positions as the Python oracle', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'positions-day.json'), 'utf8'));
  for (const office of fixture.offices) {
    const rows = fixture.issued_rows.filter((r) => r.office_id === office.office_id).map((r, i) => ({
      document_id: `x${i}`, kind: r.resend_of ? 'duplicate' : 'document', duplicate_of: r.resend_of || '', stage: 2, error: '', text: '',
      regex_fields: '{}', received_at: r.issued_at,
      llm_fields: JSON.stringify({ doc_type: r.doc_type, doc_key: r.doc_key, version: r.version, category: r.category, amount: r.amount, date: '2026-10-06', counterparty: 'c', description_en: 'd' }),
    }));
    const { payload } = computeOfficeView({ ...BERLIN, office_id: office.office_id }, rows, office.budgets, NOW);
    const expected = fixture.expected[office.office_id];
    for (const l of payload.lines) {
      const { budget, committed, credited, remaining, over_by } = l;
      assert.deepEqual({ budget, committed, credited, remaining, over_by }, expected.lines[l.category], `${office.office_id} ${l.category}`);
    }
    assert.deepEqual([payload.booked, payload.deal_count, payload.superseded_count, payload.duplicate_count],
      [expected.booked, expected.deal_count, expected.superseded_count, expected.duplicate_count], office.office_id);
  }
});

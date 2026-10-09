const test = require('node:test');
const assert = require('node:assert');
const { computeView } = require('./view');

const NOW = '2026-10-09T10:00:00Z';
const cust = { customer_id: 'acme', worker_id: 'w_tom', manager_id: 'm_anna', name: 'Acme GmbH', deleted_at: '', narrative: '', narrative_at: '' };
const row = (o) => ({ invoice_id: 'inv_1', stage: 1, regex_fields: '{}', llm_fields: '{}', error: '', text: 'some text', received_at: '2026-10-08T09:00:00Z', ...o });

test('coarse row uses regex fields; sharp row uses llm fields', () => {
  const a = row({ invoice_id: 'a', stage: 1, regex_fields: JSON.stringify({ invoice_no: 'INV-1', amount: 12.3, status: 'open' }) });
  const b = row({
    invoice_id: 'b', stage: 2, received_at: '2026-10-09T09:00:00Z', regex_fields: JSON.stringify({ amount: 1 }),
    llm_fields: JSON.stringify({ invoice_no: 'INV-2', amount: 12300, status: 'overdue', line_items_summary: 'servers' }),
  });
  const { payload, texts } = computeView(cust, [a, b], NOW);
  assert.equal(payload.stage, 1);
  assert.equal(payload.pending_count, 1);
  assert.equal(payload.invoice_count, 2);
  assert.equal(payload.overdue_count, 1);
  assert.equal(payload.overdue_amount, 12300);
  assert.equal(payload.open_amount, 12312.3);
  assert.deepEqual(payload.latest, { id: 'b', invoice_no: 'INV-2', amount: 12300, stage: 2 });
  assert.equal(payload.last_invoice_at, '2026-10-09T09:00:00Z');
  assert.equal(payload.summary_stage, 1);
  assert.ok(!('deleted_at' in payload));
  assert.match(texts.digest, /INV-2 \| \? \| 12300\.00 EUR \| due \? \| overdue \| servers/);
  assert.equal(payload.invoices[1].items, 'servers');
});

test('empty regex fields still produce a point', () => {
  const { payload, texts } = computeView(cust, [row({ regex_fields: '{}' })], NOW);
  assert.equal(payload.stage, 1);
  assert.equal(payload.latest.amount, null);
  assert.equal(payload.open_amount, 0);
  assert.match(texts.digest, /^\? \| \? \| \? EUR/);
});

test('error row counts as coarse, not pending', () => {
  const { payload } = computeView(cust, [row({ stage: -1, error: 'timeout' })], NOW);
  assert.equal(payload.stage, 1);
  assert.equal(payload.pending_count, 0);
});

test('fresh narrative is used, stale narrative is not', () => {
  const r = row({ stage: 2, llm_fields: JSON.stringify({ amount: 5, status: 'paid' }) });
  const revision = computeView(cust, [r], NOW).payload.source_revision;
  const fresh = computeView({ ...cust, narrative: 'All paid.', narrative_revision: revision, narrative_at: '2026-10-09T09:30:00Z' }, [r], NOW).payload;
  assert.equal(fresh.summary_stage, 3);
  assert.equal(fresh.summary_text, 'All paid.');
  const stale = computeView({ ...cust, narrative: 'Old.', narrative_at: '2026-10-01T00:00:00Z' }, [r], NOW).payload;
  assert.equal(stale.summary_stage, 1);
  const late = { ...cust, narrative: 'All paid.', narrative_revision: revision, narrative_at: '2026-10-10T12:00:00Z' };
  assert.equal(computeView(late, [r, row({ invoice_id: 'new', stage: 0 })], NOW).payload.summary_stage, 1);
  assert.equal(computeView(late, [{ ...r, llm_fields: JSON.stringify({ amount: 7, status: 'open' }) }], NOW).payload.summary_stage, 1);
});

test('revision ignores row order', () => {
  const a = row({ invoice_id: 'a' });
  const b = row({ invoice_id: 'b', received_at: '2026-10-09T09:00:00Z' });
  assert.equal(computeView(cust, [a, b], NOW).payload.source_revision, computeView(cust, [b, a], NOW).payload.source_revision);
});

test('deleted_at is carried through', () => {
  assert.equal(computeView({ ...cust, deleted_at: '2026-10-05T00:00:00Z' }, [row({})], NOW).payload.deleted_at, '2026-10-05T00:00:00Z');
});

test('a customer with no invoice rows yields an empty, valid view', () => {
  const { payload, texts } = computeView(cust, [], NOW);
  assert.equal(payload.stage, 0);
  assert.equal(payload.latest, null);
  assert.equal(payload.last_invoice_at, null);
  assert.equal(texts.digest, 'no invoices');
  assert.equal(texts.bm25, 'no text');
});

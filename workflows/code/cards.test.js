const test = require('node:test');
const assert = require('node:assert');
const { shapeCards, splitRemoved } = require('./cards');

const W = { w_tom: { manager_id: 'm_anna', name: 'Tom' } };
const pt = (o) => ({
  payload: {
    customer_id: 'acme', name: 'Acme', worker_id: 'w_tom', stage: 2, summary_stage: 3, summary_text: 'narr',
    pending_count: 0, invoice_count: 3, open_amount: 1, overdue_count: 0, overdue_amount: 0,
    latest: { id: 'inv_1', invoice_no: 'I', amount: 1, stage: 2 }, updated_at: 'u', ...o,
  },
});

test('rung 3 when narrative fresh', () => {
  const c = shapeCards([pt({})], W)[0];
  assert.equal(c.rung, 3);
  assert.equal(c.narrative, 'narr');
  assert.equal(c.worker, 'Tom');
  assert.equal(c.latest.id, 'inv_1');
});

test('rung follows stage without narrative', () => {
  const c = shapeCards([pt({ stage: 0, summary_stage: 1 })], W)[0];
  assert.equal(c.rung, 0);
  assert.equal(c.narrative, '');
});

test('unknown worker falls back to the worker id', () => {
  assert.equal(shapeCards([pt({ worker_id: 'w_gone' })], W)[0].worker, 'w_gone');
});

test('splitRemoved computes purge_at', () => {
  const { cards, removed } = splitRemoved(shapeCards([pt({}), pt({ customer_id: 'beta', deleted_at: '2026-10-01T00:00:00Z' })], W));
  assert.equal(cards.length, 1);
  assert.equal(removed[0].purge_at, '2026-10-31T00:00:00Z');
});

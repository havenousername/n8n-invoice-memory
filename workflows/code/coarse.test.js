const test = require('node:test');
const assert = require('node:assert');
const { coarseRead } = require('./coarse');

const EN = 'INVOICE\nInvoice No: INV-4711\nDate: 2026-10-01\nDue date: 2026-10-15\nFrom: Hetzner Online GmbH\n...\nTotal: 4,250.00 EUR';
const DE = 'RECHNUNG\nInvoice No: INV-4712\nDate: 2026-10-02\nDue date: 2026-10-16\nFrom: Hetzner Online GmbH\nTotal: 12.300,00 €';

test('english format parses correctly', () => {
  const r = coarseRead(EN);
  assert.equal(r.invoice_no, 'INV-4711');
  assert.equal(r.date, '2026-10-01');
  assert.equal(r.due_date, '2026-10-15');
  assert.equal(r.amount, 4250);
  assert.equal(r.vendor, 'Hetzner Online GmbH');
});

test('german format is deliberately wrong (the booth moment)', () => {
  assert.equal(coarseRead(DE).amount, 12.3);
});

test('empty text yields nulls, not a throw', () => {
  const nulls = { invoice_no: null, date: null, due_date: null, amount: null, vendor: null };
  assert.deepEqual(coarseRead(''), nulls);
  assert.deepEqual(coarseRead(undefined), nulls);
});

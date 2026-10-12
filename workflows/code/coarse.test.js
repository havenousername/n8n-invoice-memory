const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { coarseRead } = require('./coarse');

// Text extracted from the static PDFs with pdftotext; .flat.txt joins every line, as some extractors do.
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const NULLS = { doc_type: null, doc_key: null, version: null, date: null, cost_center: null, counterparty: null, category: null, amount: null };

test('a purchase commitment reads every field, the amount naively', () => {
  assert.deepEqual(coarseRead(fixture('muc-po-2041-v1.txt')), {
    doc_type: 'cost', doc_key: 'PO-2041', version: 1, date: '2026-10-08', cost_center: 'CC-MUC-01',
    counterparty: 'Hetzner Online GmbH', category: 'cloud', amount: 12.3,
  });
});

test('flattened text reads the same fields without one swallowing the next label', () => {
  assert.deepEqual(coarseRead(fixture('muc-po-2041-v1.flat.txt')), coarseRead(fixture('muc-po-2041-v1.txt')));
});

test('a client deal reads Kunde and Auftragswert and has no category', () => {
  const r = coarseRead(fixture('ams-deal-3101-v1.txt'));
  assert.equal(r.doc_type, 'deal');
  assert.equal(r.doc_key, 'DEAL-3101');
  assert.equal(r.counterparty, 'Van Dijk Logistics B.V.');
  assert.equal(r.category, null);
  assert.equal(r.amount, 240);
});

test('a credit note reads as credit with its category', () => {
  const r = coarseRead(fixture('par-cn-4101-v1.txt'));
  assert.deepEqual([r.doc_type, r.doc_key, r.category, r.amount], ['credit', 'CN-4101', 'cloud', 4.8]);
});

test('an amendment reads its own version, not the one it replaces', () => {
  const r = coarseRead(fixture('ber-po-1042-v2.txt'));
  assert.equal(r.version, 2);
  assert.equal(r.amount, 132);
  assert.equal(r.category, 'gpu');
});

test('every amount reads about a thousand times too small', () => {
  for (const [name, exact] of [['muc-po-2041-v1.txt', 12300], ['ams-deal-3101-v1.txt', 240000], ['par-cn-4101-v1.txt', 4800], ['ber-po-1042-v2.txt', 132000]]) {
    assert.equal(coarseRead(fixture(name)).amount * 1000, exact, name);
  }
});

test('empty or missing text yields nulls, not a throw', () => {
  assert.deepEqual(coarseRead(''), NULLS);
  assert.deepEqual(coarseRead(undefined), NULLS);
});

test('an unknown category label is null', () => {
  assert.equal(coarseRead('Kategorie: Sonstiges').category, null);
});

const test = require('node:test');
const assert = require('node:assert');
const { toNumber, validateDocument } = require('./validate');

const COST = {
  doc_type: 'cost', doc_key: 'PO-2041', version: 1, cost_center: 'CC-MUC-01', date: '2026-10-08',
  counterparty: 'Hetzner Online GmbH', category: 'cloud', amount: 12300,
  description_en: 'Dedicated servers for the staging environment, October.',
};
const DEAL = { ...COST, doc_type: 'deal', doc_key: 'DEAL-3101', category: 'none', amount: 240000 };
const CREDIT = { ...COST, doc_type: 'credit', doc_key: 'CN-4101', amount: 4800 };
const KEYS = ['doc_type', 'doc_key', 'version', 'cost_center', 'date', 'counterparty', 'category', 'amount', 'description_en'];
const check = (obj) => validateDocument(obj, 'CC-MUC-01');

test('German and English amounts still coerce', () => {
  assert.equal(toNumber('12.300,00 €'), 12300);
  assert.equal(toNumber('4,250.00'), 4250);
  assert.equal(toNumber('12,300'), 12300);
  assert.ok(Number.isNaN(toNumber('lots')));
});

test('a valid cost, deal, and credit pass', () => {
  assert.equal(check(COST).category, 'cloud');
  assert.equal(check(DEAL).category, null);
  assert.equal(check(CREDIT).doc_type, 'credit');
});

test('only the contract keys come back, with a numeric amount', () => {
  const v = check({ ...COST, amount: '12.300,00 €', confidence: 0.9 });
  assert.deepEqual(Object.keys(v).sort(), [...KEYS].sort());
  assert.equal(v.amount, 12300);
});

test('a string version is accepted as an integer', () => {
  assert.equal(check({ ...COST, version: '2' }).version, 2);
});

test('the description is trimmed to 160 characters', () => {
  assert.equal(check({ ...COST, description_en: 'x'.repeat(300) }).description_en.length, 160);
});

test('each bad field names itself', () => {
  const cases = [
    [{ doc_type: 'invoice' }, /bad doc_type/],
    [{ doc_key: 'PO-12' }, /bad doc_key/],
    [{ doc_key: 'DEAL-2041' }, /bad doc_key/], // a DEAL key on a cost
    [{ version: 0 }, /bad version/],
    [{ version: 1.5 }, /bad version/],
    [{ date: '08.10.2026' }, /bad date/],
    [{ date: '2026-13-01' }, /bad date/],
    [{ category: 'misc' }, /bad category/],
    [{ category: 'none' }, /bad category/], // a cost needs a category
    [{ amount: 'lots' }, /amount not numeric/],
    [{ amount: 0 }, /amount must be positive/],
    [{ counterparty: '' }, /missing counterparty/],
    [{ description_en: '  ' }, /missing description_en/],
  ];
  for (const [change, message] of cases) assert.throws(() => check({ ...COST, ...change }), message, JSON.stringify(change));
});

test('a deal with a category is rejected', () => {
  assert.throws(() => check({ ...DEAL, category: 'cloud' }), /bad category/);
});

test('cost center mismatch: a document is never booked to another office', () => {
  assert.throws(() => check({ ...COST, cost_center: 'CC-BER-01' }), /cost center mismatch/);
  assert.throws(() => check({ ...COST, cost_center: undefined }), /cost center mismatch/);
  assert.equal(check({ ...COST, cost_center: ' cc-muc-01 ' }).cost_center, 'CC-MUC-01');
});

test('a reply that is not an object is rejected', () => {
  assert.throws(() => check(null), /expected a JSON object/);
  assert.throws(() => check([1, 2]), /expected a JSON object/);
});

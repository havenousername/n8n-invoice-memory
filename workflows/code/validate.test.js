const test = require('node:test');
const assert = require('node:assert');
const { toNumber, validateFields } = require('./validate');

const base = {
  invoice_no: 'INV-1', date: '2026-10-01', due_date: '2026-10-15', amount: 100, vendor: 'X',
  customer_name: 'Acme GmbH', status: 'open', line_items_summary: 'servers',
};

test('german string amount coerces', () => {
  assert.equal(toNumber('12.300,00 €'), 12300);
  assert.equal(toNumber('4,250.00'), 4250);
  assert.equal(toNumber(7), 7);
});

test('a lone separator before three digits is a thousands separator', () => {
  assert.equal(toNumber('12,300'), 12300);
  assert.equal(toNumber('12.300'), 12300);
  assert.equal(toNumber('12,300 EUR'), 12300);
});

test('a lone separator before one or two digits is the decimal point', () => {
  assert.equal(toNumber('12.5'), 12.5);
  assert.equal(toNumber('12,5'), 12.5);
  assert.equal(toNumber('-3,50'), -3.5);
});

test('repeated separators are thousands separators', () => {
  assert.equal(toNumber('1.234.567,89'), 1234567.89);
  assert.equal(toNumber('1,234,567.89'), 1234567.89);
  assert.equal(toNumber('1,234,567'), 1234567);
});

test('nothing numeric is NaN, never zero', () => {
  assert.ok(Number.isNaN(toNumber('')));
  assert.ok(Number.isNaN(toNumber(null)));
  assert.ok(Number.isNaN(toNumber('lots')));
});

test('valid passes and trims summary', () => {
  const v = validateFields({ ...base, line_items_summary: 'x'.repeat(200) });
  assert.equal(v.line_items_summary.length, 120);
});

test('returns only the contract fields with a numeric amount', () => {
  const v = validateFields({ ...base, amount: '12.300,00 €', confidence: 0.9, notes: 'extra' });
  assert.deepEqual(Object.keys(v).sort(), Object.keys(base).sort());
  assert.equal(v.amount, 12300);
});

test('status is normalized before it is checked', () => {
  assert.equal(validateFields({ ...base, status: ' Overdue ' }).status, 'overdue');
});

test('bad status throws', () => assert.throws(() => validateFields({ ...base, status: 'late' }), /bad status/));
test('missing key throws', () => assert.throws(() => validateFields({ ...base, vendor: '' }), /missing vendor/));
test('non numeric amount throws', () => assert.throws(() => validateFields({ ...base, amount: 'lots' }), /amount/));
test('bad date throws', () => assert.throws(() => validateFields({ ...base, due_date: '15.10.2026' }), /bad due_date/));

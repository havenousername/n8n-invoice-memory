const test = require('node:test');
const assert = require('node:assert');
const { pickMatchedLine } = require('./match');

const inv = [
  { invoice_no: 'INV-1', vendor: 'Hetzner', items: 'Hetzner servers', status: 'open' },
  { invoice_no: 'INV-2', vendor: 'Deloitte', items: 'consulting', status: 'paid' },
];

test('picks the best overlapping line', () => assert.equal(pickMatchedLine('servers', inv), 'INV-1 · Hetzner servers'));
test('no overlap returns null', () => assert.equal(pickMatchedLine('zebra', inv), null));
test('missing invoices returns null', () => assert.equal(pickMatchedLine('servers', undefined), null));
test('short tokens are ignored', () => assert.equal(pickMatchedLine('in', inv), null));

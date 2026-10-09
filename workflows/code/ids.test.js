const test = require('node:test');
const assert = require('node:assert');
const { uuidFromHex, resolveUpload } = require('./ids');

test('uuid shape and determinism', () => {
  const h = 'a'.repeat(64);
  const u = uuidFromHex(h);
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(u, uuidFromHex(h));
  assert.notEqual(u, uuidFromHex('b'.repeat(64)));
});

test('uuid rejects input that is not a sha-256 hex digest', () => {
  assert.throws(() => uuidFromHex('abc'), /hex/);
  assert.throws(() => uuidFromHex('z'.repeat(64)), /hex/);
  assert.throws(() => uuidFromHex(undefined), /hex/);
});

test('resolveUpload derives slug and manager', () => {
  const w = { w_tom: { manager_id: 'm_anna', name: 'Tom' } };
  assert.deepEqual(resolveUpload('Acme-001.pdf', 'w_tom', w), { customer_id: 'acme', worker_id: 'w_tom', manager_id: 'm_anna' });
  assert.throws(() => resolveUpload('acme-001.pdf', 'w_nobody', w), /unknown worker/);
  assert.throws(() => resolveUpload('-001.pdf', 'w_tom', w), /no customer slug/);
});

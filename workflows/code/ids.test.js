const test = require('node:test');
const assert = require('node:assert');
const { uuidFromHex, resolveDocument } = require('./ids');

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

test('resolveDocument looks a static file up in the manifest', () => {
  const docs = { 'ber-po-1042-v1-copy.pdf': { office_id: 'berlin', manager_id: 'm_anna', worker_id: 'w_tom', duplicate_of: 'ber-po-1042-v1.pdf' },
    'muc-po-2041-v1.pdf': { office_id: 'munich', manager_id: 'm_anna', worker_id: 'w_tom', duplicate_of: null } };
  assert.deepEqual(resolveDocument('muc-po-2041-v1.pdf', docs), { office_id: 'munich', manager_id: 'm_anna', worker_id: 'w_tom', duplicate_of: null });
  assert.equal(resolveDocument('ber-po-1042-v1-copy.pdf', docs).duplicate_of, 'ber-po-1042-v1.pdf');
  assert.throws(() => resolveDocument('../../.env', docs), /unknown document/);
  assert.throws(() => resolveDocument('__proto__', docs), /unknown document/);
});

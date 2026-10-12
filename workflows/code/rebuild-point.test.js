// Runs the generated "Compute the view" Code node the way n8n does: as a function body, with $() for upstream nodes.
const test = require('node:test');
const assert = require('node:assert');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');
const { uuidFromHex } = require('./ids');

const workflow = loadWorkflow('03-rebuild-point.json');
const IDHASH = 'ab'.repeat(32);

const runComputeNode = ({ customers, invoices }) => runCodeNode(workflow, 'Compute the view', {
  upstream: {
    Config: [{ customer_id: 'acme', manager_id: 'm_anna', QDRANT_URL: 'https://x', COLLECTION: 'customers' }],
    'Hash the point id': [{ customer_id: 'acme', manager_id: 'm_anna', idhash: IDHASH }],
    'Load the customer row': customers,
    'Load all invoice rows': invoices,
  },
});

const CUSTOMER = { id: 1, customer_id: 'acme', worker_id: 'w_tom', manager_id: 'm_anna', name: 'Acme GmbH', deleted_at: null };
const SEED_INVOICE = {
  id: 7, invoice_id: 'inv_seed_a', customer_id: 'acme', manager_id: 'm_anna', stage: 1, text: 'seed',
  regex_fields: '{"invoice_no":"INV-4711","amount":12.3,"status":"open"}', llm_fields: '', error: '',
  received_at: '2026-10-09T15:00:00.000Z',
};

test('seeded rows become one upsert body for the tenant shard', async () => {
  const [item] = await runComputeNode({ customers: [CUSTOMER], invoices: [SEED_INVOICE] });
  const { body } = item.json;
  assert.equal(body.shard_key, 'm_anna');
  const [point] = body.points;
  assert.equal(point.id, uuidFromHex(IDHASH));
  assert.equal(point.payload.customer_id, 'acme');
  assert.equal(point.payload.worker_id, 'w_tom');
  assert.equal(point.payload.stage, 1);
  assert.equal(point.payload.latest.amount, 12.3);
  assert.deepEqual(Object.keys(point.vector).sort(), ['bm25', 'digest', 'summary']);
  assert.equal(point.vector.bm25.text, 'seed');
  assert.equal(point.vector.digest.model, 'answerdotai/answerai-colbert-small-v1');
});

test('the empty item from Always Output Data is not a row', async () => {
  const [item] = await runComputeNode({ customers: [CUSTOMER], invoices: [{}] });
  assert.equal(item.json.body.points[0].payload.invoice_count, 0);
});

test('a missing customer row stops the run', async () => {
  await assert.rejects(runComputeNode({ customers: [{}], invoices: [{}] }), /no customer row for m_anna\/acme/);
});

test('duplicate customer rows stop the run instead of picking one', async () => {
  await assert.rejects(runComputeNode({ customers: [CUSTOMER, CUSTOMER], invoices: [] }), /2 customer rows/);
});

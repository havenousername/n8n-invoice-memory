// 02b Write the narrative: its three Code nodes, run as n8n runs them.
const test = require('node:test');
const assert = require('node:assert');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');
const { uuidFromHex } = require('./ids');

const workflow = loadWorkflow('02b-narrative.json');
const CONFIG = { customer_id: 'acme', manager_id: 'm_anna', OPENROUTER_MODEL: 'anthropic/claude-haiku-5.5' };
const SHARP = {
  manager_id: 'm_anna', customer_id: 'acme', stage: 2, pending_count: 0, source_revision: 'rev-1',
  invoice_count: 1, open_amount: 12300, overdue_count: 1, overdue_amount: 12300, last_invoice_at: '2026-10-09T10:00:00Z',
  invoices: [{ invoice_no: 'INV-4711', date: '2026-09-01', amount: 12300, due_date: '2026-09-15', status: 'overdue', items: 'Hetzner servers' }],
};
const snapshot = (payload) => runCodeNode(workflow, 'Prepare the narrative snapshot', {
  upstream: { Config: [CONFIG] }, input: [{ json: { result: payload ? [{ id: 'p', payload }] : [] } }],
});

test('the point id and read request come from the hash', async () => {
  const [item] = await runCodeNode(workflow, 'Format the point id', {
    upstream: { Config: [CONFIG] }, input: [{ json: { ...CONFIG, idhash: 'cd'.repeat(32) } }],
  });
  const id = uuidFromHex('cd'.repeat(32));
  assert.equal(item.json.id, id);
  assert.deepEqual(item.json.body, { shard_key: 'm_anna', ids: [id], with_payload: true });
});

test('a sharp point becomes a strict-schema narrative request', async () => {
  const [item] = await snapshot(SHARP);
  const { body } = item.json;
  assert.equal(item.json.payload.source_revision, 'rev-1');
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['narrative']);
  assert.match(body.messages[1].content, /INV-4711 \| 2026-09-01 \| 12300 EUR \| due 2026-09-15 \| overdue \| Hetzner servers/);
  assert.match(body.messages[1].content, /"overdue_amount":12300/);
});

test('a coarse or pending point waits for its sharp stage', async () => {
  assert.deepEqual(await snapshot({ ...SHARP, stage: 1 }), []);
  assert.deepEqual(await snapshot({ ...SHARP, pending_count: 1 }), []);
});

test('a missing or foreign point stops the run', async () => {
  await assert.rejects(snapshot(null), /missing tenant point/);
  await assert.rejects(snapshot({ ...SHARP, manager_id: 'm_ben' }), /missing tenant point/);
});

const keep = (content) => runCodeNode(workflow, 'Keep only the narrative', {
  upstream: { 'Prepare the narrative snapshot': [{ payload: SHARP }] },
  input: [{ json: { choices: [{ message: { content } }] } }],
});

test('the narrative is kept with the snapshot revision it was written from', async () => {
  const text = 'Acme has one overdue invoice of 12,300 EUR for servers.';
  const [item] = await keep(JSON.stringify({ narrative: text }));
  assert.equal(item.json.narrative, text);
  assert.equal(item.json.revision, 'rev-1');
  assert.match(item.json.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('a long narrative is cut, a short or broken one stops the run', async () => {
  const [item] = await keep(JSON.stringify({ narrative: 'x'.repeat(900) }));
  assert.equal(item.json.narrative.length, 600);
  await assert.rejects(keep(JSON.stringify({ narrative: 'too short' })), /bad narrative/);
  await assert.rejects(keep('```json\n{}\n```'), /JSON/);
});

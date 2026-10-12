// 02b Write the summary: its three Code nodes, run as n8n runs them.
const test = require('node:test');
const assert = require('node:assert');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');
const { uuidFromHex } = require('./ids');

const workflow = loadWorkflow('02b-summary.json');
const CONFIG = { office_id: 'berlin', manager_id: 'm_anna', OPENROUTER_MODEL: 'anthropic/claude-haiku-5.5' };
const line = (category, name, budget, committed, over_by = 0) => ({ category, name, budget, committed, credited: 0, remaining: budget - committed, over_by });
const SHARP = {
  manager_id: 'm_anna', office_id: 'berlin', name: 'Berlin', stage: 2, pending_count: 0, summary_stage: 1, source_revision: 'rev-1',
  committed: 152000, budget: 1275000, used_pct: 11.9, booked: 300000, deal_count: 1,
  lines: [line('people', 'People', 820000, 0), line('cloud', 'Cloud infrastructure', 180000, 20000),
    line('gpu', 'GPU compute', 120000, 132000, 12000), line('office', 'Office and facilities', 95000, 0), line('travel', 'Travel and events', 60000, 0)],
  documents: [
    { doc_key: 'PO-1042', version: 1, status: 'superseded', kind: 'document', doc_type: 'cost', category: 'gpu', amount: 48000, description_en: 'GPU servers, deposit' },
    { doc_key: 'PO-1042', version: 1, status: 'duplicate', kind: 'duplicate', doc_type: null, category: null, amount: null, description_en: null },
    { doc_key: 'DEAL-6000', version: 1, status: 'current', kind: 'document', doc_type: 'deal', category: null, amount: 300000, description_en: 'Platform licence' },
    { doc_key: 'PO-1042', version: 2, status: 'current', kind: 'document', doc_type: 'cost', category: 'gpu', amount: 132000, description_en: 'GPU servers, order expanded' },
  ],
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

test('a sharp office becomes a strict-schema summary request with its budget position and the amendment', async () => {
  const [item] = await snapshot(SHARP);
  const { body } = item.json;
  assert.equal(item.json.payload.source_revision, 'rev-1');
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['narrative']);
  const user = body.messages[1].content;
  assert.match(user, /"category":"GPU compute","budget":120000,"committed":132000,"credited":0,"over_by":12000/);
  assert.match(user, /"booked":300000/);
  assert.match(user, /PO-1042 v1 \| superseded \| cost \| gpu \| 48000 EUR \| GPU servers, deposit/);
  assert.match(user, /PO-1042 v2 \| current/);
  assert.doesNotMatch(user, /duplicate/);
  assert.match(body.messages[0].content, /amendments/);
});

test('a rough, pending, or already summarized office makes no model call', async () => {
  assert.deepEqual(await snapshot({ ...SHARP, stage: 1 }), []);
  assert.deepEqual(await snapshot({ ...SHARP, pending_count: 1 }), []);
  assert.deepEqual(await snapshot({ ...SHARP, summary_stage: 3 }), []);
});

test('a missing or foreign point stops the run', async () => {
  await assert.rejects(snapshot(null), /missing tenant point/);
  await assert.rejects(snapshot({ ...SHARP, manager_id: 'm_ben' }), /missing tenant point/);
  await assert.rejects(snapshot({ ...SHARP, office_id: 'munich' }), /missing tenant point/);
});

const keep = (content) => runCodeNode(workflow, 'Keep only the narrative', {
  upstream: { 'Prepare the narrative snapshot': [{ payload: SHARP }] },
  input: [{ json: { choices: [{ message: { content } }] } }],
});

test('the narrative is kept with the snapshot revision it was written from', async () => {
  const text = 'Berlin has committed 152,000 EUR and is 12,000 EUR over plan in GPU compute.';
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

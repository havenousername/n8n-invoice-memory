// Runs the generated "Compute the view" Code node the way n8n does: as a function body, with $() for upstream nodes.
const test = require('node:test');
const assert = require('node:assert');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');
const { uuidFromHex } = require('./ids');

const workflow = loadWorkflow('03-rebuild-office-point.json');
const IDHASH = 'ab'.repeat(32);

const runComputeNode = ({ office = 'berlin', manager = 'm_anna', officeRows = [], documents = [] }) =>
  runCodeNode(workflow, 'Compute the view', {
    upstream: {
      Config: [{ office_id: office, manager_id: manager, QDRANT_URL: 'https://x', COLLECTION: 'offices' }],
      'Hash the point id': [{ office_id: office, manager_id: manager, idhash: IDHASH }],
      'Load the office row': officeRows,
      'Load all document rows': documents,
    },
  });

const OFFICE_ROW = { id: 1, office_id: 'berlin', manager_id: 'm_anna', name: 'Berlin', narrative: 'old text', narrative_at: null, narrative_revision: 'stale' };
const SHARP_ROW = {
  id: 7, document_id: 'doc_a', kind: 'document', duplicate_of: '', office_id: 'berlin', manager_id: 'm_anna', worker_id: 'w_tom',
  filename: 'ber-po-1042-v1.pdf', text: 'BESTELLUNG PO-1042', stage: 2, error: '', received_at: '2026-10-14T09:00:00.000Z',
  regex_fields: '{}', pdf_base64: 'JVBERi0x',
  llm_fields: JSON.stringify({ doc_type: 'cost', doc_key: 'PO-1042', version: 1, cost_center: 'CC-BER-01', date: '2026-10-06',
    counterparty: 'Rechenwerk Systems GmbH', category: 'gpu', amount: 48000, description_en: 'GPU servers' }),
};

test('document rows become one upsert body for the tenant shard, with budgets from OFFICES', async () => {
  const [item] = await runComputeNode({ officeRows: [OFFICE_ROW], documents: [SHARP_ROW] });
  const { body } = item.json;
  assert.equal(body.shard_key, 'm_anna');
  const [point] = body.points;
  assert.equal(point.id, uuidFromHex(IDHASH));
  assert.equal(point.payload.office_id, 'berlin');
  assert.equal(point.payload.name, 'Berlin');
  assert.equal(point.payload.region, 'Central');
  const gpu = point.payload.lines.find((l) => l.category === 'gpu');
  assert.deepEqual([gpu.budget, gpu.committed, gpu.remaining], [120000, 48000, 72000]);
  assert.equal(point.payload.summary_stage, 1, 'a narrative from another revision is stale');
  assert.deepEqual(Object.keys(point.vector).sort(), ['bm25', 'digest', 'summary']);
  assert.equal(point.vector.digest.model, 'answerdotai/answerai-colbert-small-v1');
  assert.ok(!JSON.stringify(point.payload).includes('JVBERi0x'), 'the PDF stays in the table');
});

test('an office with no row and no documents still gets its empty point (reconcile before the first document)', async () => {
  const [item] = await runComputeNode({ officeRows: [{}], documents: [{}] });
  const { payload } = item.json.body.points[0];
  assert.equal(payload.stage, 0);
  assert.equal(payload.committed, 0);
  assert.equal(payload.latest, null);
});

test('an unknown office or a foreign manager stops the run', async () => {
  await assert.rejects(runComputeNode({ office: 'rome' }), /unknown office m_anna\/rome/);
  await assert.rejects(runComputeNode({ manager: 'm_ben' }), /unknown office m_ben\/berlin/);
});

test('duplicate office rows stop the run instead of picking one', async () => {
  await assert.rejects(runComputeNode({ officeRows: [OFFICE_ROW, OFFICE_ROW] }), /2 office rows/);
});

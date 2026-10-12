// 01b Record a document: its two Code nodes, run as n8n runs them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');

const workflow = loadWorkflow('01b-record-a-document.json');
const SAMPLE = (file) => fs.readFileSync(path.join(__dirname, '..', '..', 'samples', file));
const validate = (input) => runCodeNode(workflow, 'Validate the submission', { input: [{ json: input }] });
const GENERATED = { filename: 'par-po-5002-v1.pdf', pdf_base64: SAMPLE('par-cn-4101-v1.pdf').toString('base64'), office_id: 'paris', worker_id: 'w_jules' };

test('a static file resolves from the booth pool with its PDF inlined', async () => {
  const [item] = await validate({ file: 'ber-po-1042-v1-copy.pdf' });
  const v = item.json;
  assert.match(v.document_id, /^doc_[a-z0-9]+$/);
  assert.deepEqual([v.office_id, v.manager_id, v.worker_id, v.office_name, v.filename],
    ['berlin', 'm_anna', 'w_tom', 'DevSummit Berlin', 'ber-po-1042-v1-copy.pdf']);
  assert.equal(v.pdf_base64, SAMPLE('ber-po-1042-v1-copy.pdf').toString('base64'));
  assert.match(v.received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('only the booth pool is static: gate documents and paths are unknown', async () => {
  await assert.rejects(validate({ file: 'ams-deal-3101-v1.pdf' }), /unknown document/);
  await assert.rejects(validate({ file: '../../.env' }), /unknown document/);
});

test('a generated PDF from the working day is checked before it is recorded', async () => {
  const [item] = await validate(GENERATED);
  assert.deepEqual([item.json.office_id, item.json.manager_id, item.json.worker_id], ['paris', 'm_ben', 'w_jules']);
  assert.equal(item.json.pdf_base64, GENERATED.pdf_base64);
  await assert.rejects(validate({ ...GENERATED, office_id: 'rome' }), /unknown office rome/);
  await assert.rejects(validate({ ...GENERATED, worker_id: 'w_tom' }), /does not file for paris/);
  await assert.rejects(validate({ ...GENERATED, filename: 'ber-po-5002-v1.pdf' }), /bad filename/);
  await assert.rejects(validate({ ...GENERATED, filename: 'par-po-5002-v1.pdf.exe' }), /bad filename/);
  await assert.rejects(validate({ ...GENERATED, pdf_base64: Buffer.from('<html>').toString('base64') }), /not a PDF/);
});

const VALIDATED = {
  document_id: 'doc_new', office_id: 'berlin', manager_id: 'm_anna', worker_id: 'w_tom', office_name: 'Berlin',
  filename: 'ber-po-1042-v1-copy.pdf', pdf_base64: 'JVBERi0x', received_at: '2026-10-14T09:00:00Z',
};
const build = (lookup) => runCodeNode(workflow, 'Build the rows', {
  upstream: { 'Validate the submission': [VALIDATED], 'Hash the PDF': [{ pdf_hash: 'h1' }] }, input: [{ json: lookup }],
});

test('a new document gets a stage-0 row that carries its PDF', async () => {
  const [item] = await build({});
  assert.equal(item.json.duplicate, false);
  assert.deepEqual(item.json.office, { office_id: 'berlin', manager_id: 'm_anna', name: 'Berlin' });
  assert.deepEqual(item.json.row, {
    document_id: 'doc_new', kind: 'document', duplicate_of: '', office_id: 'berlin', manager_id: 'm_anna', worker_id: 'w_tom',
    pdf_hash: 'h1', filename: 'ber-po-1042-v1-copy.pdf', text: '', stage: 0, regex_fields: '{}', llm_fields: '{}', error: '',
    received_at: '2026-10-14T09:00:00Z', pdf_base64: 'JVBERi0x',
  });
});

test('a known hash makes a duplicate row that points at the original', async () => {
  const [item] = await build({ id: 3, document_id: 'doc_first', filename: 'ber-po-1042-v1.pdf', kind: 'document' });
  assert.equal(item.json.duplicate, true);
  assert.equal(item.json.original_filename, 'ber-po-1042-v1.pdf');
  assert.equal(item.json.row.kind, 'duplicate');
  assert.equal(item.json.row.duplicate_of, 'doc_first');
});

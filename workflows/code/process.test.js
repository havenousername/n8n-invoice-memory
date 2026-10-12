// 02 Process: its Code nodes, run as n8n runs them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');

const workflow = loadWorkflow('02-process.json');
const PDF = fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'muc-po-2041-v1.pdf'));
const CONFIG = {
  document_id: 'doc_1', office_id: 'munich', manager_id: 'm_anna', filename: 'muc-po-2041-v1.pdf',
  pdf_base64: PDF.toString('base64'), OPENROUTER_MODEL: 'anthropic/claude-haiku-5.5', PDF_ENGINE: 'native',
};
const FIELDS = ['doc_type', 'doc_key', 'version', 'cost_center', 'date', 'counterparty', 'category', 'amount', 'description_en'];

test('the PDF comes out of the row as the binary for text extraction', async () => {
  const [item] = await runCodeNode(workflow, 'Read the PDF from the row', { upstream: { Config: [CONFIG] } });
  assert.equal(item.binary.data.fileName, 'muc-po-2041-v1.pdf');
  assert.equal(item.binary.data.mimeType, 'application/pdf');
  assert.deepEqual(Buffer.from(item.binary.data.data, 'base64'), PDF);
});

test('a row without a PDF goes to the error output', async () => {
  await assert.rejects(runCodeNode(workflow, 'Read the PDF from the row', { upstream: { Config: [{ ...CONFIG, pdf_base64: '' }] } }),
    /no PDF in the row for doc_1/);
});

test('the vision request carries the row PDF, the strict schema, and keeps the binary', async () => {
  const binary = { data: { mimeType: 'application/pdf', fileName: 'muc-po-2041-v1.pdf' } };
  const [item] = await runCodeNode(workflow, 'Prepare the vision request', { upstream: { Config: [CONFIG] }, input: [{ json: {}, binary }] });
  const { body } = item.json;
  assert.equal(item.binary, binary);
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.deepEqual(body.plugins, [{ id: 'file-parser', pdf: { engine: 'native' } }]);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, FIELDS);
  const file = body.messages[1].content.find((part) => part.type === 'file').file;
  assert.equal(file.file_data, `data:application/pdf;base64,${CONFIG.pdf_base64}`);
});

test('the rough read keeps the text and misreads the German amount', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'muc-po-2041-v1.txt'), 'utf8');
  const [item] = await runCodeNode(workflow, 'Coarse read with regex', { input: [{ json: { text } }] });
  assert.equal(item.json.text, text);
  const fields = JSON.parse(item.json.regex_fields);
  assert.equal(fields.doc_key, 'PO-2041');
  assert.equal(fields.amount, 12.3);
});

test('a scanned PDF with no text still gets a rough row', async () => {
  const [item] = await runCodeNode(workflow, 'Coarse read with regex', { input: [{ json: {} }] });
  assert.equal(item.json.text, '');
  assert.equal(JSON.parse(item.json.regex_fields).amount, null);
});

const validate = (fields, office = 'munich') => runCodeNode(workflow, 'Validate the fields', {
  upstream: { Config: [{ ...CONFIG, office_id: office }] },
  input: [{ json: { choices: [{ message: { content: JSON.stringify(fields) } }] } }],
});
const GOOD = {
  doc_type: 'cost', doc_key: 'PO-2041', version: 1, cost_center: 'CC-MUC-01', date: '2026-10-08',
  counterparty: 'Hetzner Online GmbH', category: 'cloud', amount: 12300, description_en: 'Dedicated servers for staging',
};

test('validated fields are stored as JSON, checked against the office cost center', async () => {
  const [item] = await validate(GOOD);
  assert.equal(JSON.parse(item.json.llm_fields).amount, 12300);
  await assert.rejects(validate(GOOD, 'berlin'), /cost center mismatch/);
});

test('invalid fields stop the node so its error output records stage -1', async () => {
  await assert.rejects(validate({ ...GOOD, category: 'snacks' }), /bad category/);
  await assert.rejects(validate(GOOD, 'rome'), /unknown office rome/);
});

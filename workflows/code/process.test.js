// 02 Process: its three Code nodes, run as n8n runs them.
const test = require('node:test');
const assert = require('node:assert');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');

const workflow = loadWorkflow('02-process.json');
const CONFIG = { invoice_id: 'inv_1', customer_id: 'acme', manager_id: 'm_anna', OPENROUTER_MODEL: 'anthropic/claude-haiku-5.5', PDF_ENGINE: 'native' };
const PDF = Buffer.from('%PDF-1.4 synthetic');
const FIELDS = ['invoice_no', 'date', 'due_date', 'amount', 'vendor', 'customer_name', 'status', 'line_items_summary'];

test('the vision request carries the PDF, the strict schema, and keeps the binary for text extraction', async () => {
  const binary = { data: { mimeType: 'application/pdf', fileName: 'acme-001.pdf' } };
  const [item] = await runCodeNode(workflow, 'Prepare the vision request', {
    upstream: { Config: [CONFIG] }, input: [{ json: {}, binary }], binaryBuffers: { data: PDF },
  });
  const { body } = item.json;
  assert.equal(item.binary, binary);
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.deepEqual(body.plugins, [{ id: 'file-parser', pdf: { engine: 'native' } }]);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, FIELDS);
  for (const field of FIELDS) assert.match(body.messages[0].content, new RegExp(field));
  const file = body.messages[1].content.find((part) => part.type === 'file').file;
  assert.equal(file.file_data, `data:application/pdf;base64,${PDF.toString('base64')}`);
});

test('the coarse read keeps the text and the regex fields', async () => {
  const text = 'INVOICE\nInvoice No: INV-4730\nDate: 2026-09-20\nDue date: 2026-10-20\nFrom: Hetzner\nTotal: 4,250.00 EUR';
  const [item] = await runCodeNode(workflow, 'Coarse read with regex', { input: [{ json: { text } }] });
  assert.equal(item.json.text, text);
  assert.equal(JSON.parse(item.json.regex_fields).amount, 4250);
});

test('a scanned PDF with no text still gets a coarse row', async () => {
  const [item] = await runCodeNode(workflow, 'Coarse read with regex', { input: [{ json: {} }] });
  assert.equal(item.json.text, '');
  assert.equal(JSON.parse(item.json.regex_fields).amount, null);
});

const validate = (fields) => runCodeNode(workflow, 'Validate the fields', {
  input: [{ json: { choices: [{ message: { content: JSON.stringify(fields) } }] } }],
});
const GOOD = {
  invoice_no: 'INV-4711', date: '2026-09-01', due_date: '2026-09-15', amount: '12.300,00 €', vendor: 'Hetzner',
  customer_name: 'Acme GmbH', status: 'Overdue', line_items_summary: 'servers',
};

test('validated fields are stored as JSON with a numeric amount', async () => {
  const [item] = await validate(GOOD);
  const stored = JSON.parse(item.json.llm_fields);
  assert.equal(stored.amount, 12300);
  assert.equal(stored.status, 'overdue');
});

test('invalid fields stop the node so its error output records stage -1', async () => {
  await assert.rejects(validate({ ...GOOD, status: 'late' }), /bad status/);
});

// 01 Ingest: its two Code nodes, run as n8n runs them.
const test = require('node:test');
const assert = require('node:assert');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');

const workflow = loadWorkflow('01-ingest.json');
const BASE = 'https://raw.githubusercontent.com/havenousername/n8n-invoice-memory/main/samples';
const CONFIG = {
  SAMPLES_BASE_URL: BASE,
  SAMPLES: JSON.stringify(['acme-001.pdf', 'beta-003.pdf']),
  CUSTOMER_NAMES: JSON.stringify({ acme: 'Acme GmbH', beta: 'Beta Logistics AG' }),
  WORKERS: JSON.stringify({ w_tom: { manager_id: 'm_anna', name: 'Tom' }, w_jules: { manager_id: 'm_ben', name: 'Jules' } }),
};
const submit = (Invoice, Worker) => runCodeNode(workflow, 'Validate the submission', {
  upstream: { Config: [{ ...CONFIG, Invoice, Worker }] },
});

test('a valid submission resolves tenant, customer, and the sample URL', async () => {
  const [item] = await submit('acme-001.pdf', 'Tom');
  const v = item.json;
  assert.match(v.invoice_id, /^inv_[a-z0-9]+$/);
  assert.equal(v.customer_id, 'acme');
  assert.equal(v.customer_name, 'Acme GmbH');
  assert.equal(v.worker_id, 'w_tom');
  assert.equal(v.manager_id, 'm_anna');
  assert.equal(v.filename, 'acme-001.pdf');
  assert.equal(v.sample_url, `${BASE}/acme-001.pdf`);
  assert.match(v.received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('only allowlisted samples and known workers get through', async () => {
  await assert.rejects(submit('../../.env', 'Tom'), /unknown sample/);
  await assert.rejects(submit('gamma-001.pdf', 'Tom'), /unknown sample/);
  await assert.rejects(submit('acme-001.pdf', 'Eve'), /unknown worker/);
});

const decide = async (existingCustomer) => {
  const [validated] = await submit('acme-001.pdf', 'Tom');
  return runCodeNode(workflow, 'Decide the rows', {
    upstream: { 'Validate the submission': [validated.json], 'Hash the PDF': [{ pdf_hash: 'h1' }] },
    input: [{ json: existingCustomer }],
  });
};

test('a new customer belongs to the submitting worker', async () => {
  const [item] = await decide({});
  const { customer, invoice } = item.json;
  assert.deepEqual(customer, { customer_id: 'acme', manager_id: 'm_anna', worker_id: 'w_tom', name: 'Acme GmbH' });
  assert.equal(invoice.pdf_hash, 'h1');
  assert.equal(invoice.stage, 0);
  assert.deepEqual([invoice.text, invoice.regex_fields, invoice.llm_fields, invoice.error], ['', '{}', '{}', '']);
  assert.equal(invoice.worker_id, 'w_tom');
});

test('an existing customer keeps its first worker and its name', async () => {
  const [item] = await decide({ id: 3, customer_id: 'acme', manager_id: 'm_anna', worker_id: 'w_lena', name: 'Acme Holding' });
  assert.equal(item.json.customer.worker_id, 'w_lena');
  assert.equal(item.json.customer.name, 'Acme Holding');
  assert.equal(item.json.invoice.worker_id, 'w_tom');
});

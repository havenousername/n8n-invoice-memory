// 00 Working day: its three Code nodes, run as n8n runs them.
const test = require('node:test');
const assert = require('node:assert');
const { loadWorkflow, runCodeNode } = require('./n8n-harness');
const { renderPdf } = require('./pdf');

const workflow = loadWorkflow('00-working-day.json');
const CONFIG = { count: 12, OPENROUTER_MODEL: 'anthropic/claude-haiku-5.5' };
const OFFICE_IDS = ['berlin', 'munich', 'vienna', 'amsterdam', 'paris', 'london'];

const plan = (count) => runCodeNode(workflow, 'Plan the day', { upstream: { Config: [{ ...CONFIG, count }] } });

test('a day of 12 slots visits every office; the count is bounded', async () => {
  const slots = await plan(12);
  assert.equal(slots.length, 12);
  assert.deepEqual(new Set(slots.map((s) => s.json.office_id)), new Set(OFFICE_IDS));
  assert.deepEqual(slots.map((s) => s.json.slot), [...Array(12).keys()].map((i) => i + 1));
  assert.equal((await plan('lots')).length, 12);
  assert.equal((await plan(1000)).length, 40);
  assert.equal((await plan(-3)).length, 1);
});

const issued = (office_id, doc_key, version, doc_type, category, amount, minute, extra = {}) => ({
  id: minute, issued_id: `iss_${minute}`, office_id, manager_id: office_id === 'paris' ? 'm_ben' : 'm_anna', worker_id: 'w',
  doc_type, doc_key, version, date: '2026-10-14', counterparty: 'Rechenwerk Systems GmbH', category, amount,
  description_de: `${doc_key} Beschreibung`, description_en: `${doc_key} description`, resend_of: '',
  filename: `${office_id.slice(0, 3)}-${doc_key.toLowerCase()}-v${version}.pdf`, issued_at: `2026-10-14T09:${String(minute).padStart(2, '0')}:00Z`, ...extra,
});
const ISSUED = [
  issued('berlin', 'PO-5000', 1, 'cost', 'gpu', 48000, 1),
  issued('paris', 'PO-5001', 1, 'cost', 'travel', 30000, 2),
  issued('berlin', 'CN-7000', 1, 'credit', 'gpu', 5000, 3),
  issued('berlin', 'DEAL-6000', 1, 'deal', '', 300000, 4),
  issued('berlin', 'PO-5000', 2, 'cost', 'gpu', 45000, 5),
  issued('berlin', 'PO-5000', 2, 'cost', 'gpu', 45000, 6, { resend_of: 'ber-po-5000-v2.pdf', filename: 'ber-po-5000-v2-copy.pdf' }),
];
const prepare = (office_id, rows = ISSUED, action = 'new_cost') => runCodeNode(workflow, 'Prepare the worker request', {
  upstream: { Config: [CONFIG], 'Loop over slots': [{ slot: 1, office_id, action }], 'Read the issued documents': rows },
});
const contextOf = (body) => JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n'));

test('the request shows the office its own recent documents and its committed position', async () => {
  const [item] = await prepare('berlin');
  const { recent, numbers, body } = item.json;
  assert.deepEqual(recent.map((r) => r.issued_id), ['iss_1', 'iss_3', 'iss_4', 'iss_5', 'iss_6']);
  assert.deepEqual(numbers, ['PO-5000', 'PO-5001', 'CN-7000', 'DEAL-6000', 'PO-5000', 'PO-5000']);
  const context = contextOf(body);
  assert.equal(context.cost_center, 'CC-BER-01');
  assert.equal(context.event, 'DevSummit Berlin');
  assert.deepEqual(context.committed, { gpu: 40000 }, 'v2 replaces v1, the credit gives back, the resend and the deal do not count');
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
});

test('the planned action is resolved against the event: an amendment may only name what it has', async () => {
  const [deal] = await prepare('berlin', ISSUED, 'amend_deal');
  assert.deepEqual(deal.json.slot, { action: 'amend', targets: ['DEAL-6000'], side: 'deal' });
  assert.deepEqual(deal.json.body.response_format.json_schema.schema.properties.target_key.enum, ['DEAL-6000']);
  const [fallback] = await prepare('london', [{}], 'resend');
  assert.deepEqual(fallback.json.slot, { action: 'new_deal', targets: [] });
});

test('only the last eight documents are shown, and an empty table is a quiet office', async () => {
  const many = [...Array(11).keys()].map((i) => issued('berlin', `PO-${5000 + i}`, 1, 'cost', 'cloud', 1000, i + 10));
  const [item] = await prepare('berlin', many);
  assert.equal(item.json.recent.length, 8);
  assert.equal(item.json.recent[0].doc_key, 'PO-5003');
  const [quiet] = await prepare('london', [{}]);
  assert.deepEqual([quiet.json.recent, quiet.json.numbers], [[], []]);
});

const issue = async (proposed, action = 'new_deal', office_id = 'berlin') => {
  const [prep] = await prepare(office_id, ISSUED, action);
  return runCodeNode(workflow, 'Issue the document', {
    upstream: { 'Prepare the worker request': [prep.json] },
    input: [{ json: { choices: [{ message: { content: JSON.stringify(proposed) } }] } }],
  });
};
const EVENT = { action: 'new_deal', target_key: '', counterparty: 'Nordzee Data B.V.', category: 'none', amount: 60000,
  description_de: 'Gold-Sponsoring inklusive Keynote-Slot', description_en: 'Gold sponsorship including a keynote slot' };

test('an accepted event becomes a rendered PDF for 01b and an issued row', async () => {
  const [item] = await issue(EVENT);
  const out = item.json;
  assert.equal(out.filename, 'ber-deal-6001-v1.pdf');
  assert.ok(out.pdf_base64.startsWith('JVBERi0'));
  assert.deepEqual([out.office_id, out.manager_id, out.worker_id], ['berlin', 'm_anna', 'w_tom']);
  assert.match(Buffer.from(out.pdf_base64, 'base64').toString('latin1'), /KUNDENAUFTRAG/);
  assert.equal(out.issued.doc_key, 'DEAL-6001');
  assert.equal(out.issued.category, '');
  assert.equal(out.issued.resend_of, '');
  assert.equal(out.issued.filename, out.filename);
  assert.match(out.issued.issued_id, /^iss_[a-z0-9]+$/);
});

test('a resend is byte-identical to the original it repeats', async () => {
  const [item] = await issue({ ...EVENT, action: 'resend', target_key: 'PO-5000' }, 'resend');
  assert.equal(item.json.filename, 'ber-po-5000-v2-copy.pdf');
  assert.equal(item.json.issued.resend_of, 'ber-po-5000-v2.pdf');
  const OFFICES_BERLIN = { name: 'DevSummit Berlin', cost_center: 'CC-BER-01', worker_name: 'Tom' };
  const original = renderPdf({ ...ISSUED[4], category: 'gpu' }, OFFICES_BERLIN);
  assert.deepEqual(Buffer.from(item.json.pdf_base64, 'base64'), Buffer.from(original));
});

test('a rejected event yields no document: the reason goes to the error output', async () => {
  await assert.rejects(issue({ ...EVENT, category: 'cloud' }), /category on a deal/);
  await assert.rejects(issue({ ...EVENT, action: 'amend', target_key: 'PO-9999' }, 'amend_cost'), /unknown target_key/);
  await assert.rejects(issue({ ...EVENT, action: 'new_cost', category: 'gpu', amount: 5000 }, 'new_deal'), /unexpected action new_cost/);
  await assert.rejects(runCodeNode(workflow, 'Issue the document', {
    upstream: { 'Prepare the worker request': [{ office_id: 'berlin', recent: [], numbers: [] }] },
    input: [{ json: { choices: [{ message: { content: '```json {}```' } }] } }],
  }), /not bare JSON/);
});

const test = require('node:test');
const assert = require('node:assert');
const { planSlots, workerRequest, checkEvent, toDocument } = require('./worker');
const { renderPdf } = require('./pdf');

const OFFICES = ['berlin', 'munich', 'vienna', 'amsterdam', 'paris', 'london'].map((office_id) => ({ office_id }));
const BERLIN = {
  office_id: 'berlin', code: 'ber', name: 'Berlin', cost_center: 'CC-BER-01', worker_name: 'Tom',
  budgets: { people: 820000, cloud: 180000, gpu: 120000, office: 95000, travel: 60000 },
  committed: { people: 0, cloud: 20000, gpu: 48000, office: 0, travel: 0 },
};
const NOW = '2026-10-14T09:30:00Z';
const issued = (doc_key, version, doc_type, category, amount, extra = {}) => ({
  doc_key, version, doc_type, category, amount, date: '2026-10-13', counterparty: 'Rechenwerk Systems GmbH',
  description_de: `${doc_key} Beschreibung`, description_en: `${doc_key} description`,
  filename: `ber-${doc_key.toLowerCase()}-v${version}.pdf`, resend_of: null, ...extra,
});
const RECENT = [
  issued('PO-5000', 1, 'cost', 'gpu', 48000),
  issued('DEAL-6000', 1, 'deal', null, 300000, { counterparty: 'Van Dijk Logistics B.V.' }),
  issued('PO-5000', 2, 'cost', 'gpu', 40000),
];
const event = (fields) => ({
  action: 'new_cost', target_key: '', counterparty: 'Hetzner Online GmbH', category: 'cloud', amount: 12300,
  description_de: 'Server für Staging', description_en: 'Servers for staging', ...fields,
});
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test('slots cover all six offices in every burst of 12', () => {
  for (const seed of [1, 7, 42, 1234, 99991]) {
    const slots = planSlots(12, OFFICES, seeded(seed));
    assert.equal(slots.length, 12);
    assert.deepEqual(new Set(slots.map((s) => s.office_id)), new Set(OFFICES.map((o) => o.office_id)), `seed ${seed}`);
  }
  assert.equal(planSlots(5, OFFICES, seeded(3)).length, 5);
});

test('the request is strict, offers the five actions, and shows the recent keys', () => {
  const body = workerRequest(BERLIN, RECENT, 'anthropic/claude-haiku-5.5');
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  const { json_schema } = body.response_format;
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(json_schema.strict, true);
  assert.equal(json_schema.schema.additionalProperties, false);
  assert.deepEqual(json_schema.schema.properties.action.enum, ['new_cost', 'new_deal', 'new_credit', 'amend', 'resend']);
  assert.deepEqual(json_schema.schema.required.sort(),
    ['action', 'amount', 'category', 'counterparty', 'description_de', 'description_en', 'target_key']);
  const prompt = body.messages.map((m) => m.content).join('\n');
  for (const s of ['PO-5000', 'DEAL-6000', 'CC-BER-01', '120000', '48000']) assert.ok(prompt.includes(s), s);
});

test('rejected events: each reason', () => {
  const cases = [
    [event({ amount: 999 }), /amount out of range/],
    [event({ amount: 1000000 }), /amount out of range/],
    [event({ category: 'gpu', amount: 48001 }), /amount out of range/], // above 40% of Berlin's 120000 GPU budget
    [event({ amount: '12.300,00' }), /amount out of range/],
    [event({ category: 'snacks' }), /bad category/],
    [event({ category: 'none' }), /bad category/],
    [event({ action: 'new_deal', category: 'cloud' }), /category on a deal/],
    [event({ action: 'amend', target_key: 'PO-9999' }), /unknown target_key/],
    [event({ action: 'resend', target_key: '' }), /unknown target_key/],
    [event({ counterparty: ' ' }), /missing counterparty/],
    [event({ description_de: '  ' }), /missing description/],
    [event({ description_en: '' }), /missing description/],
    [event({ action: 'refund' }), /bad action/],
  ];
  for (const [e, reason] of cases) assert.throws(() => checkEvent(e, BERLIN, RECENT), reason, JSON.stringify(e));
});

test('accepted events come back normalized; a deal has no category', () => {
  assert.equal(checkEvent(event({ amount: 12300.004 }), BERLIN, RECENT).amount, 12300);
  assert.equal(checkEvent(event({ action: 'new_deal', category: 'none', amount: 250000 }), BERLIN, RECENT).category, null);
  assert.equal(checkEvent(event({ action: 'new_credit', category: 'cloud', amount: 4800 }), BERLIN, RECENT).category, 'cloud');
  // A credit note is not capped by the 40% rule; only commitments are.
  assert.equal(checkEvent(event({ action: 'new_credit', category: 'gpu', amount: 90000 }), BERLIN, RECENT).amount, 90000);
});

test('new keys never collide with anything issued, and start at the ruled floors', () => {
  const numbers = ['PO-5000', 'PO-5007', 'DEAL-6000', 'CN-7000'];
  assert.equal(toDocument(checkEvent(event({}), BERLIN, RECENT), BERLIN, RECENT, numbers, NOW).doc.doc_key, 'PO-5008');
  const deal = checkEvent(event({ action: 'new_deal', category: 'none', amount: 250000 }), BERLIN, RECENT);
  assert.equal(toDocument(deal, BERLIN, RECENT, numbers, NOW).doc.doc_key, 'DEAL-6001');
  const credit = checkEvent(event({ action: 'new_credit' }), BERLIN, RECENT);
  assert.equal(toDocument(credit, BERLIN, RECENT, [], NOW).doc.doc_key, 'CN-7000');
  assert.equal(toDocument(checkEvent(event({}), BERLIN, []), BERLIN, [], ['PO-1042'], NOW).doc.doc_key, 'PO-5000');
  // Recent keys count even when the caller's list misses them.
  assert.equal(toDocument(checkEvent(event({}), BERLIN, RECENT), BERLIN, RECENT, [], NOW).doc.doc_key, 'PO-5001');
});

test('a new document is version 1, dated today, named by office code, key, and version', () => {
  const { doc, filename, resend_of } = toDocument(checkEvent(event({}), BERLIN, RECENT), BERLIN, RECENT, ['PO-5000'], NOW);
  assert.deepEqual(doc, {
    doc_type: 'cost', doc_key: 'PO-5001', version: 1, date: '2026-10-14', counterparty: 'Hetzner Online GmbH',
    category: 'cloud', amount: 12300, description_de: 'Server für Staging', description_en: 'Servers for staging',
  });
  assert.equal(filename, 'ber-po-5001-v1.pdf');
  assert.equal(resend_of, null);
});

test('an amendment keeps its key, takes the latest version plus one, and keeps the category unless changed', () => {
  const amend = checkEvent(event({ action: 'amend', target_key: 'PO-5000', category: 'none', counterparty: '', amount: 45000 }), BERLIN, RECENT);
  const { doc, filename } = toDocument(amend, BERLIN, RECENT, ['PO-5000', 'DEAL-6000'], NOW);
  assert.equal(doc.doc_key, 'PO-5000');
  assert.equal(doc.version, 3);
  assert.equal(doc.category, 'gpu');
  assert.equal(doc.counterparty, 'Rechenwerk Systems GmbH');
  assert.equal(doc.amount, 45000);
  assert.equal(filename, 'ber-po-5000-v3.pdf');
});

test('an amendment of a deal never gains a category, and its amount is checked against the target type', () => {
  assert.throws(() => checkEvent(event({ action: 'amend', target_key: 'DEAL-6000', category: 'cloud' }), BERLIN, RECENT), /category on a deal/);
  const ok = checkEvent(event({ action: 'amend', target_key: 'DEAL-6000', category: 'none', amount: 400000 }), BERLIN, RECENT);
  assert.equal(toDocument(ok, BERLIN, RECENT, [], NOW).doc.doc_type, 'deal');
  // A GPU commitment amended above 40% of the GPU budget is out of range.
  assert.throws(() => checkEvent(event({ action: 'amend', target_key: 'PO-5000', category: 'none', amount: 50000 }), BERLIN, RECENT), /amount out of range/);
});

test('a resend is the original document, byte-identical, with -copy in the file name', () => {
  const resend = checkEvent(event({ action: 'resend', target_key: 'PO-5000', amount: 1 }), BERLIN, RECENT);
  const { doc, filename, resend_of } = toDocument(resend, BERLIN, RECENT, ['PO-5000'], NOW);
  const original = RECENT[2];
  assert.equal(filename, 'ber-po-5000-v2-copy.pdf');
  assert.equal(resend_of, 'ber-po-5000-v2.pdf');
  assert.deepEqual(Buffer.from(renderPdf(doc, BERLIN)), Buffer.from(renderPdf(original, BERLIN)));
});

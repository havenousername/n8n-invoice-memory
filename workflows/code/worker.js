// The AI workers: which office acts next, what the model is asked, and how its answer becomes a document.
// The model only proposes; code checks every value and assigns keys and versions. Pasted into n8n Code nodes
// without the module.exports line.

const WORKER_ACTIONS = ['new_cost', 'new_deal', 'new_credit', 'amend', 'resend'];
const WORKER_NEW_TYPES = { new_cost: 'cost', new_deal: 'deal', new_credit: 'credit' };
const WORKER_CATEGORIES = ['people', 'cloud', 'gpu', 'office', 'travel'];
const WORKER_KEYS = { cost: ['PO', 5000], deal: ['DEAL', 6000], credit: ['CN', 7000] };
const WORKER_COST_SHARE = 0.4;
const WORKER_PROMPT = [
  'You play the controller of one office of Q8nten GmbH, a software company, during Q4 2026.',
  'Propose the next business document for this office as JSON.',
  'Actions: new_cost (a purchase commitment to a supplier), new_deal (a client deal), new_credit (a credit note from a supplier),',
  'amend (a new version of one recent document with the same key and a new total amount), resend (the same recent document sent again).',
  'Mostly new costs, some deals, now and then a credit note, an amendment, or a resend.',
  'target_key: for amend and resend, one key from the recent list; otherwise an empty string.',
  'category: people, cloud, gpu, office, or travel for costs and credit notes; none for deals.',
  'amount: EUR between 1000 and 999999; one commitment stays within 40% of its category budget.',
  'counterparty: a plausible company (a supplier for costs and credit notes, a client for deals).',
  'description_de: one short German line as printed on the document; description_en: its English translation.',
].join(' ');
const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: WORKER_ACTIONS },
    target_key: { type: 'string', description: 'a recent key for amend or resend, else empty' },
    counterparty: { type: 'string' },
    category: { type: 'string', enum: [...WORKER_CATEGORIES, 'none'] },
    amount: { type: 'number', description: 'EUR' },
    description_de: { type: 'string' },
    description_en: { type: 'string' },
  },
  required: ['action', 'target_key', 'counterparty', 'category', 'amount', 'description_de', 'description_en'],
  additionalProperties: false,
};

// Each round is a fresh shuffle of every office, so any two rounds (12 slots for six offices) hold each office twice.
function planSlots(count, offices, random) {
  const slots = [];
  while (slots.length < count) {
    const round = offices.slice();
    for (let i = round.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [round[i], round[j]] = [round[j], round[i]];
    }
    slots.push(...round.map((o) => ({ office_id: o.office_id })));
  }
  return slots.slice(0, count);
}

// `office` carries its budgets and, when the caller knows it, its committed position per category.
function workerRequest(office, recent, model) {
  const context = {
    office: office.name, cost_center: office.cost_center, budgets: office.budgets, committed: office.committed || {},
    recent: workerOriginals(recent).map((r) => ({ key: r.doc_key, version: r.version, type: r.doc_type, category: r.category,
      amount: r.amount, description: r.description_en })),
  };
  return {
    model, temperature: 0.9, max_tokens: 400,
    response_format: { type: 'json_schema', json_schema: { name: 'business_event', strict: true, schema: WORKER_SCHEMA } },
    messages: [{ role: 'system', content: WORKER_PROMPT }, { role: 'user', content: JSON.stringify(context) }],
  };
}

// Throws the reason a proposed event is rejected; returns it normalized otherwise.
function checkEvent(event, office, recent) {
  if (!WORKER_ACTIONS.includes(event.action)) throw new Error(`bad action ${event.action}`);
  const isNew = Object.hasOwn(WORKER_NEW_TYPES, event.action);
  const target = isNew ? null : workerLatest(event.target_key, recent);
  if (!isNew && !target) throw new Error(`unknown target_key ${event.target_key}`);
  if (event.action === 'resend') return { action: 'resend', target_key: target.doc_key };

  const docType = isNew ? WORKER_NEW_TYPES[event.action] : target.doc_type;
  const asked = event.category && event.category !== 'none' ? event.category : null;
  let category = null;
  if (docType === 'deal') {
    if (asked !== null) throw new Error('category on a deal');
  } else {
    category = asked ?? (target ? target.category : null);
    if (!WORKER_CATEGORIES.includes(category)) throw new Error(`bad category ${event.category}`);
  }
  const amount = typeof event.amount === 'number' ? Math.round(event.amount * 100) / 100 : NaN;
  const cap = docType === 'cost' ? office.budgets[category] * WORKER_COST_SHARE : Infinity;
  if (!(amount >= 1000 && amount < 1000000 && amount <= cap)) throw new Error(`amount out of range ${event.amount}`);
  const counterparty = String(event.counterparty || '').trim() || (target ? target.counterparty : '');
  if (!counterparty) throw new Error('missing counterparty');
  const description_de = String(event.description_de || '').trim();
  const description_en = String(event.description_en || '').trim();
  if (!description_de || !description_en) throw new Error('missing description');
  return { action: event.action, target_key: target ? target.doc_key : '', doc_type: docType, counterparty, category, amount,
    description_de, description_en };
}

// `numbers` holds every key issued so far, any office; a new key is one above the highest of its type.
function toDocument(event, office, recent, numbers, nowIso) {
  const target = isNewEvent(event) ? null : workerLatest(event.target_key, recent);
  if (event.action === 'resend') {
    const doc = {
      doc_type: target.doc_type, doc_key: target.doc_key, version: Number(target.version), date: target.date,
      counterparty: target.counterparty, category: target.category ?? null, amount: Number(target.amount),
      description_de: target.description_de, description_en: target.description_en,
    };
    const original = workerFilename(office, doc);
    return { doc, filename: original.replace(/\.pdf$/, '-copy.pdf'), resend_of: original };
  }
  const doc = {
    doc_type: event.doc_type,
    doc_key: target ? target.doc_key : workerNextKey(event.doc_type, [...numbers, ...recent.map((r) => r.doc_key)]),
    version: target ? Number(target.version) + 1 : 1,
    date: nowIso.slice(0, 10),
    counterparty: event.counterparty, category: event.category, amount: event.amount,
    description_de: event.description_de, description_en: event.description_en,
  };
  return { doc, filename: workerFilename(office, doc), resend_of: null };
}

function isNewEvent(event) {
  return Object.hasOwn(WORKER_NEW_TYPES, event.action);
}

function workerOriginals(recent) {
  return recent.filter((r) => !r.resend_of);
}

function workerLatest(key, recent) {
  if (typeof key !== 'string' || !key) return null;
  return workerOriginals(recent).filter((r) => r.doc_key === key)
    .reduce((best, r) => (!best || Number(r.version) > Number(best.version) ? r : best), null);
}

function workerNextKey(docType, numbers) {
  const [prefix, floor] = WORKER_KEYS[docType];
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let next = floor;
  for (const key of numbers) {
    const m = pattern.exec(key);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  return `${prefix}-${next}`;
}

function workerFilename(office, doc) {
  return `${office.code}-${doc.doc_key.toLowerCase()}-v${doc.version}.pdf`;
}

module.exports = { planSlots, workerRequest, checkEvent, toDocument };

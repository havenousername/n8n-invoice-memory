// The AI workers of Q8nten, an event agency: which event acts next and what happens to it, what the model is asked,
// and how its answer becomes a document. Code decides the action of every slot, so customers, amendments, credits,
// and resends really appear; the model only writes the content, and code checks every value and assigns keys and
// versions. Pasted into n8n Code nodes without the module.exports line.

const WORKER_ACTIONS = ['new_cost', 'new_deal', 'new_credit', 'amend', 'resend'];
const WORKER_NEW_TYPES = { new_cost: 'cost', new_deal: 'deal', new_credit: 'credit' };
const WORKER_CATEGORIES = ['people', 'cloud', 'gpu', 'office', 'travel'];
const WORKER_KEYS = { cost: ['PO', 5000], deal: ['DEAL', 6000], credit: ['CN', 7000] };
const WORKER_COST_SHARE = 0.4;
/** Every 12 slots hand out this mix: as many customer orders as supplier orders, and every kind of change. */
const WORKER_MIX = ['new_cost', 'new_cost', 'new_cost', 'new_cost', 'new_deal', 'new_deal', 'new_deal', 'new_deal',
  'amend_cost', 'amend_deal', 'new_credit', 'resend'];
const WORKER_PROMPT = [
  'You play an event producer at Q8nten GmbH, an event agency, during Q4 2026.',
  'You write the next document for one of its events, as JSON. The action is already decided; write its content.',
  'Supplier orders (new_cost) buy for the event: crew and staffing (people), marketing (cloud), stage, light, sound and video (gpu),',
  'the venue and rooms (office), or catering (travel). Customer orders (new_deal) are sponsors and exhibitors booking in:',
  'sponsorship packages, exhibition stands, ticket contingents; category none. Credit notes (new_credit) come from suppliers:',
  'a cancelled room, refunded no-shows, a short delivery. Amendments (amend) give a new total for the target_key: usually the',
  'event is growing or a sponsor upgrades. Resends (resend) name the target_key of a document that arrives a second time.',
  'target_key: one of the allowed keys for amend and resend, otherwise an empty string.',
  'amount: EUR between 1000 and 999999; one supplier order stays within 40% of its budget line.',
  'counterparty: a plausible company (a supplier for orders and credit notes, the sponsor or exhibitor for customer orders).',
  'description_de: one short German line as printed on the document; description_en: its English translation.',
].join(' ');
const WORKER_SLOT = {
  new_cost: 'This slot: a new supplier order for this event.',
  new_deal: 'This slot: a new customer order, a sponsor or exhibitor books in.',
  new_credit: 'This slot: a supplier credit note.',
  amend_cost: 'This slot: a supplier order changes; give its new total.',
  amend_deal: 'This slot: a sponsor or exhibitor order changes (an upgrade, a bigger stand); give its new total.',
  resend: 'This slot: one of the documents arrives a second time; name its key.',
};

function workerSchema(slot) {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [slot.action] },
      target_key: { type: 'string', enum: slot.targets.length ? slot.targets : [''] },
      counterparty: { type: 'string' },
      category: { type: 'string', enum: [...WORKER_CATEGORIES, 'none'] },
      amount: { type: 'number', description: 'EUR' },
      description_de: { type: 'string' },
      description_en: { type: 'string' },
    },
    required: ['action', 'target_key', 'counterparty', 'category', 'amount', 'description_de', 'description_en'],
    additionalProperties: false,
  };
}

// Each round is a fresh shuffle of every office, so any 12 slots hold each of six offices twice; actions come from a
// shuffled bag of WORKER_MIX, so any 12 slots hold the whole mix.
function planSlots(count, offices, random) {
  const shuffle = (items) => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const places = [];
  while (places.length < count) places.push(...shuffle(offices).map((o) => o.office_id));
  const actions = [];
  while (actions.length < count) actions.push(...shuffle(WORKER_MIX));
  return places.slice(0, count).map((office_id, i) => ({ office_id, action: actions[i] }));
}

// The planned action against what the office really has: an amendment needs an original of its kind, a resend any
// original; without one the slot becomes a new order of the same side.
function resolveAction(planned, recent) {
  const keys = (type) => [...new Set(workerOriginals(recent).filter((r) => !type || r.doc_type === type).map((r) => r.doc_key))];
  if (planned === 'amend_cost') return keys('cost').length ? { action: 'amend', targets: keys('cost'), side: 'cost' } : { action: 'new_cost', targets: [] };
  if (planned === 'amend_deal') return keys('deal').length ? { action: 'amend', targets: keys('deal'), side: 'deal' } : { action: 'new_deal', targets: [] };
  if (planned === 'resend') return keys().length ? { action: 'resend', targets: keys() } : { action: 'new_deal', targets: [] };
  return { action: planned, targets: [] };
}

// `office` carries its budgets and, when the caller knows it, its committed position per category.
function workerRequest(office, recent, model, slot) {
  const context = {
    event: office.name, cost_center: office.cost_center, budgets: office.budgets, committed: office.committed || {},
    recent: workerOriginals(recent).map((r) => ({ key: r.doc_key, version: r.version, type: r.doc_type, category: r.category,
      amount: r.amount, description: r.description_en })),
    allowed_targets: slot.targets,
  };
  const instruction = WORKER_SLOT[slot.action === 'amend' ? `amend_${slot.side}` : slot.action];
  return {
    model, temperature: 0.9, max_tokens: 400,
    response_format: { type: 'json_schema', json_schema: { name: 'business_event', strict: true, schema: workerSchema(slot) } },
    messages: [{ role: 'system', content: WORKER_PROMPT }, { role: 'user', content: `${instruction}\n${JSON.stringify(context)}` }],
  };
}

// Throws the reason a proposed event is rejected; returns it normalized otherwise. With a slot, the event must be the
// slot's action and name one of its targets.
function checkEvent(event, office, recent, slot) {
  if (!WORKER_ACTIONS.includes(event.action)) throw new Error(`bad action ${event.action}`);
  if (slot && event.action !== slot.action) throw new Error(`unexpected action ${event.action}`);
  if (slot && slot.targets.length && !slot.targets.includes(event.target_key)) throw new Error(`unknown target_key ${event.target_key}`);
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

module.exports = { planSlots, resolveAction, workerRequest, checkEvent, toDocument };

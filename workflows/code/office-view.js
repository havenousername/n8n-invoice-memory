// The office point as a view over documents rows. Pasted into n8n Code nodes without the module.exports line.

// Each event's five budget lines. The keys are internal slots shared with the vision schema; the names are what people read.
const VIEW_CATEGORIES = [['people', 'Crew and staffing'], ['cloud', 'Marketing'], ['gpu', 'Stage and AV'], ['office', 'Venue'], ['travel', 'Catering']];
const VIEW_TYPE_NAMES = { cost: 'Supplier order', deal: 'Customer order', credit: 'Credit note' };

function computeOfficeView(office, rows, budgets, nowIso) {
  const entries = rows.map(viewEntry).sort((a, b) => a.received_at.localeCompare(b.received_at));
  markCurrentVersions(entries);
  const current = entries.filter((e) => e.status === 'current');
  const pending = entries.filter((e) => e.status === 'pending');

  const costs = {}, credits = {};
  let booked = 0, dealCount = 0;
  for (const e of current) {
    if (e.amount === null) continue;
    if (e.doc_type === 'deal') { booked += e.amount; dealCount += 1; }
    else if (e.doc_type === 'cost' && e.category) costs[e.category] = (costs[e.category] || 0) + e.amount;
    else if (e.doc_type === 'credit' && e.category) credits[e.category] = (credits[e.category] || 0) + e.amount;
  }
  const lines = VIEW_CATEGORIES.map(([category, name]) => {
    const budget = budgets[category] || 0;
    const committed = round2(Math.max(0, (costs[category] || 0) - (credits[category] || 0)));
    return { category, name, budget, committed, credited: round2(credits[category] || 0),
      remaining: round2(budget - committed), over_by: round2(Math.max(0, committed - budget)) };
  });
  const budget = lines.reduce((s, l) => s + l.budget, 0);
  const committed = round2(lines.reduce((s, l) => s + l.committed, 0));

  // An error counts as rough (stage 1) for the stage but is terminal, so it is not pending.
  const effective = (e) => (e.stage < 0 ? 1 : e.stage);
  const stage = [...current, ...pending].reduce((min, e) => Math.min(min, effective(e)), Infinity);
  const pendingCount = pending.length + current.filter((e) => e.stage === 1).length;
  const revision = sourceRevision(rows);
  const newest = entries[entries.length - 1] || null;
  const fresh = stage === 2 && pendingCount === 0 && !!office.narrative && office.narrative_revision === revision;
  const over = lines.filter((l) => l.over_by > 0);
  const mechanical = `${office.name}: ${viewMoney(committed)} of ${viewMoney(budget)} committed (${pct(committed, budget)}%), `
    + (over.length ? `over plan in ${over.map((l) => l.name).join(' and ')}` : 'nothing over plan')
    + `, ${dealCount} sponsor and exhibitor ${dealCount === 1 ? 'order' : 'orders'} booked worth ${viewMoney(round2(booked))}.`;

  const payload = {
    office_id: office.office_id, manager_id: office.manager_id, name: office.name, region: office.region,
    stage: stage === Infinity ? 0 : stage, pending_count: pendingCount,
    lines, budget, committed, used_pct: pct(committed, budget), booked: round2(booked), deal_count: dealCount,
    documents: entries.map(({ text, ...rest }) => rest),
    superseded_count: entries.filter((e) => e.status === 'superseded').length,
    duplicate_count: entries.filter((e) => e.status === 'duplicate').length,
    latest: newest && { document_id: newest.document_id, kind: newest.kind, doc_type: newest.doc_type, doc_key: newest.doc_key,
      version: newest.version, stage: newest.stage, amount: newest.amount, status: newest.status, received_at: newest.received_at },
    source_revision: revision,
    summary_stage: fresh ? 3 : 1,
    summary_text: fresh ? office.narrative : mechanical,
    summary_generated_at: fresh ? office.narrative_at : nowIso,
    updated_at: nowIso,
  };
  const descriptions = current.map((e) => e.description_en).filter(Boolean);
  return {
    payload,
    texts: {
      summary: payload.summary_text,
      digest: current.map(digestOf).join('\n') || 'no documents',
      bm25: [...rows.map((r) => r.text || ''), ...descriptions].join('\n').trim() || 'no text',
    },
  };
}

// What was read: the vision fields once sharp, the regex fields while rough or after an error.
function viewEntry(row) {
  const stage = Number(row.stage);
  const kind = row.kind === 'duplicate' ? 'duplicate' : 'document';
  const f = stage === 0 || kind === 'duplicate' ? {} : parseJsonObject(stage >= 2 ? row.llm_fields : row.regex_fields);
  return {
    document_id: row.document_id, kind, duplicate_of: row.duplicate_of || null, filename: row.filename || null,
    doc_type: f.doc_type || null, doc_key: f.doc_key || null, version: Number.isInteger(f.version) ? f.version : null,
    counterparty: f.counterparty || null, category: f.category || null,
    amount: Number.isFinite(f.amount) ? f.amount : null, description_en: f.description_en || null, date: f.date || null,
    stage, error: row.error || '', received_at: String(row.received_at || ''), text: row.text || '',
    status: kind === 'duplicate' ? 'duplicate' : stage === 0 ? 'pending' : 'current',
  };
}

// Per key, the highest version read is current; ties go to the latest received. Unkeyed reads stand alone.
function markCurrentVersions(entries) {
  const best = {};
  for (const e of entries) {
    if (e.status !== 'current' || !e.doc_key) continue;
    const held = best[e.doc_key];
    if (!held || (e.version ?? 0) > (held.version ?? 0) || ((e.version ?? 0) === (held.version ?? 0) && e.received_at >= held.received_at)) {
      if (held) held.status = 'superseded';
      best[e.doc_key] = e;
    } else {
      e.status = 'superseded';
    }
  }
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

// Fingerprint of the rows a summary was written from; any change makes the summary stale.
function sourceRevision(rows) {
  const tuples = rows.map((r) => [r.document_id, r.kind || 'document', r.duplicate_of || '', r.stage, r.regex_fields || '{}',
    r.llm_fields || '{}', r.error || '', r.received_at || '']);
  return JSON.stringify(tuples.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function digestOf(e) {
  const category = VIEW_CATEGORIES.find(([key]) => key === e.category);
  const amount = e.amount === null ? '?' : e.amount.toFixed(2);
  return `${e.doc_key || '?'} v${e.version ?? '?'} | ${e.date || '?'} | ${VIEW_TYPE_NAMES[e.doc_type] || '?'} | `
    + `${category ? category[1] : '-'} | ${e.counterparty || '?'} | ${amount} EUR | ${e.description_en || ''}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function viewMoney(n) {
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
}

module.exports = { computeOfficeView };

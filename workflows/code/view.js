// The customer point as a view over Data Table rows. Pasted into n8n Code nodes without the module.exports line.

function computeView(customer, invoiceRows, nowIso) {
  const invoices = invoiceRows.map(invoiceEntry).sort((a, b) => a.received_at.localeCompare(b.received_at));
  const priced = invoices.filter((i) => i.amount !== null);
  const open = priced.filter((i) => i.status !== 'paid');
  const overdue = priced.filter((i) => i.status === 'overdue');
  const stage = invoices.length ? Math.min(...invoices.map((i) => (i.stage < 0 ? 1 : i.stage))) : 0;
  const pending = invoices.filter((i) => i.stage === 0 || i.stage === 1).length;
  const last = invoices[invoices.length - 1] || null;
  const revision = sourceRevision(invoiceRows);
  const fresh = stage === 2 && pending === 0 && !!customer.narrative && customer.narrative_revision === revision;
  const openAmount = roundedSum(open.map((i) => i.amount));
  const mechanical = `${invoices.length} invoices, ${openAmount.toFixed(2)} EUR open, ${overdue.length} overdue, `
    + `last ${last ? last.received_at.slice(0, 10) : 'never'}`;

  const payload = {
    manager_id: customer.manager_id,
    worker_id: customer.worker_id,
    customer_id: customer.customer_id,
    name: customer.name || customer.customer_id,
    stage,
    pending_count: pending,
    invoice_count: invoices.length,
    total_amount: roundedSum(priced.map((i) => i.amount)),
    open_amount: openAmount,
    overdue_count: overdue.length,
    overdue_amount: roundedSum(overdue.map((i) => i.amount)),
    last_invoice_at: last ? last.received_at : null,
    latest: last ? { id: last.id, invoice_no: last.invoice_no, amount: last.amount, stage: last.stage } : null,
    source_revision: revision,
    summary_stage: fresh ? 3 : 1,
    summary_text: fresh ? customer.narrative : mechanical,
    summary_generated_at: fresh ? customer.narrative_at : nowIso,
    updated_at: nowIso,
    invoices: invoices.map(({ received_at, ...rest }) => rest),
  };
  if (customer.deleted_at) payload.deleted_at = customer.deleted_at;

  return {
    payload,
    texts: {
      summary: payload.summary_text,
      digest: invoices.map(digestLine).join('\n') || 'no invoices',
      bm25: invoiceRows.map((r) => r.text || '').join('\n').trim() || 'no text',
    },
  };
}

// A coarse row shows its regex fields until the vision stage (2) replaces them.
function invoiceEntry(row) {
  const stage = Number(row.stage);
  const f = parseFieldsJson(stage >= 2 ? row.llm_fields : row.regex_fields);
  return {
    id: row.invoice_id,
    invoice_no: f.invoice_no || null,
    date: f.date || null,
    due_date: f.due_date || null,
    amount: Number.isFinite(f.amount) ? f.amount : null,
    vendor: f.vendor || null,
    status: f.status || 'open',
    stage,
    error: row.error || '',
    items: f.line_items_summary || '',
    received_at: String(row.received_at || ''),
  };
}

function parseFieldsJson(text) {
  try {
    return JSON.parse(text || '{}') || {};
  } catch {
    return {};
  }
}

// Fingerprint of the invoice rows a narrative was written from; any change makes the narrative stale.
function sourceRevision(invoiceRows) {
  const tuples = invoiceRows.map((r) => [
    r.invoice_id, r.stage, r.regex_fields || '{}', r.llm_fields || '{}', r.error || '', r.received_at || '',
  ]);
  return JSON.stringify(tuples.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function digestLine(i) {
  const amount = i.amount === null ? '?' : i.amount.toFixed(2);
  return `${i.invoice_no || '?'} | ${i.date || '?'} | ${amount} EUR | due ${i.due_date || '?'} | ${i.status} | ${i.items}`;
}

function roundedSum(amounts) {
  return +amounts.reduce((a, b) => a + b, 0).toFixed(2);
}

module.exports = { computeView };

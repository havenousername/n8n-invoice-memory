// Glue for "Prepare the narrative snapshot" in 02b Write the narrative.
// Only a sharp point is narrated: every invoice read by the vision stage, none pending. The payload travels on,
// so the narrative is saved with the source_revision it was written from and goes stale if the rows change.
const cfg = $('Config').first().json;
const payload = (($json.result || [])[0] || {}).payload;
if (!payload || payload.manager_id !== cfg.manager_id || payload.customer_id !== cfg.customer_id) {
  throw new Error(`missing tenant point for ${cfg.manager_id}/${cfg.customer_id}`);
}
if (payload.stage !== 2 || payload.pending_count !== 0) return [];
const { invoice_count, open_amount, overdue_count, overdue_amount, last_invoice_at } = payload;
const aggregates = { invoice_count, open_amount, overdue_count, overdue_amount, last_invoice_at };
const lines = payload.invoices.map((i) => `${i.invoice_no} | ${i.date} | ${i.amount} EUR | due ${i.due_date} | ${i.status} | ${i.items}`);
const body = {
  model: cfg.OPENROUTER_MODEL,
  temperature: 0,
  max_tokens: 300,
  response_format: { type: 'json_schema', json_schema: { name: 'narrative', strict: true, schema: {
    type: 'object', additionalProperties: false, required: ['narrative'], properties: { narrative: { type: 'string' } },
  } } },
  messages: [
    { role: 'system', content: 'You write for a manager. Three plain sentences about this customer: what is open, what is overdue, what changed most recently. No bullet points.' },
    { role: 'user', content: `Aggregates: ${JSON.stringify(aggregates)}\nInvoices:\n${lines.join('\n')}` },
  ],
};
return [{ json: { payload, body } }];

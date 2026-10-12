// Glue for "Decide the rows" in 01 Ingest. Its input is the existing customer row, or an empty item.
// The first worker keeps the customer and its name is never overwritten; the invoice records who submitted it.
const v = $('Validate the submission').first().json;
const existing = $json.customer_id ? $json : {};
return [{ json: {
  customer: {
    customer_id: v.customer_id,
    manager_id: v.manager_id,
    worker_id: existing.worker_id || v.worker_id,
    name: existing.name || v.customer_name,
  },
  invoice: {
    invoice_id: v.invoice_id,
    customer_id: v.customer_id,
    worker_id: v.worker_id,
    manager_id: v.manager_id,
    pdf_hash: $('Hash the PDF').first().json.pdf_hash,
    filename: v.filename,
    text: '',
    stage: 0,
    regex_fields: '{}',
    llm_fields: '{}',
    error: '',
    received_at: v.received_at,
  },
} }];

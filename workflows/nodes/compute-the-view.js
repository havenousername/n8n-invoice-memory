// Glue for the "Compute the view" Code node in 03 Rebuild point.
// scripts/build_workflows.py pastes ids.js and view.js above this; n8n runs the whole as a function body.
const cfg = $('Config').first().json;
const customers = $('Load the customer row').all().map((i) => i.json).filter((r) => r.customer_id);
const invoiceRows = $('Load all invoice rows').all().map((i) => i.json).filter((r) => r.invoice_id);
if (!customers.length) throw new Error(`no customer row for ${cfg.manager_id}/${cfg.customer_id}`);
if (customers.length > 1) throw new Error(`${customers.length} customer rows for ${cfg.manager_id}/${cfg.customer_id}`);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const { payload, texts } = computeView(customers[0], invoiceRows, now);
const id = uuidFromHex($('Hash the point id').first().json.idhash);
return [{ json: { body: {
  shard_key: cfg.manager_id,
  points: [{ id, payload, vector: {
    summary: { text: texts.summary, model: 'sentence-transformers/all-minilm-l6-v2' },
    digest: { text: texts.digest, model: 'answerdotai/answerai-colbert-small-v1' },
    bm25: { text: texts.bm25, model: 'qdrant/bm25' },
  } }],
} } }];

// Glue for "Validate the submission" in 01 Ingest; ids.js is pasted above it.
// Form dropdowns are not a trust boundary, since anyone can post any value: the sample must be on the
// manifest allowlist and the worker must be known before anything is downloaded.
const cfg = $('Config').first().json;
const samples = JSON.parse(cfg.SAMPLES);
const workers = JSON.parse(cfg.WORKERS);
const names = JSON.parse(cfg.CUSTOMER_NAMES);
if (!samples.includes(cfg.Invoice)) throw new Error(`unknown sample ${cfg.Invoice}`);
const workerId = Object.keys(workers).find((id) => workers[id].name === cfg.Worker);
if (!workerId) throw new Error(`unknown worker ${cfg.Worker}`);
const resolved = resolveUpload(cfg.Invoice, workerId, workers);
return [{ json: {
  ...resolved,
  customer_name: Object.hasOwn(names, resolved.customer_id) ? names[resolved.customer_id] : resolved.customer_id,
  invoice_id: `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  filename: cfg.Invoice,
  sample_url: `${cfg.SAMPLES_BASE_URL}/${cfg.Invoice}`,
  received_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
} }];

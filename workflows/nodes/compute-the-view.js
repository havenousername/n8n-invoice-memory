// Glue for the "Compute the view" Code node in 03 Rebuild office point.
// build_workflows.py pastes OFFICES, ids.js, and office-view.js above this; n8n runs the whole as a function body.
// Name, region, and budgets come from OFFICES; the office row only adds the saved summary.
const cfg = $('Config').first().json;
const office = OFFICES.find((o) => o.office_id === cfg.office_id);
if (!office || office.manager_id !== cfg.manager_id) throw new Error(`unknown office ${cfg.manager_id}/${cfg.office_id}`);
const officeRows = $('Load the office row').all().map((i) => i.json).filter((r) => r.office_id);
if (officeRows.length > 1) throw new Error(`${officeRows.length} office rows for ${cfg.manager_id}/${cfg.office_id}`);
const saved = officeRows[0] || {};
const rows = $('Load all document rows').all().map((i) => i.json).filter((r) => r.document_id);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const { payload, texts } = computeOfficeView(
  { ...office, narrative: saved.narrative, narrative_at: saved.narrative_at, narrative_revision: saved.narrative_revision },
  rows, office.budgets, now);
const id = uuidFromHex($('Hash the point id').first().json.idhash);
return [{ json: { body: {
  shard_key: cfg.manager_id,
  points: [{ id, payload, vector: {
    summary: { text: texts.summary, model: 'sentence-transformers/all-minilm-l6-v2' },
    digest: { text: texts.digest, model: 'answerdotai/answerai-colbert-small-v1' },
    bm25: { text: texts.bm25, model: 'qdrant/bm25' },
  } }],
} } }];

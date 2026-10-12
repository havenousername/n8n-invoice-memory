// Glue for "Prepare the worker request" in 00 Working day; worker.js and OFFICES are pasted above it.
// The office's issued documents are its memory: the last 8 are shown to the model, all of them give its position,
// and every key issued anywhere keeps new keys unique.
const slot = $('Loop over slots').first(1).json;
const office = OFFICES.find((o) => o.office_id === slot.office_id);
const issued = $('Read the issued documents').all().map((i) => i.json).filter((r) => r.issued_id);
const mine = issued.filter((r) => r.office_id === office.office_id)
  .sort((a, b) => String(a.issued_at).localeCompare(String(b.issued_at)));
const current = {};
for (const r of mine) {
  if (!r.resend_of && (!current[r.doc_key] || Number(r.version) > Number(current[r.doc_key].version))) current[r.doc_key] = r;
}
const committed = {};
for (const r of Object.values(current)) {
  if (r.doc_type === 'deal' || !r.category) continue;
  committed[r.category] = (committed[r.category] || 0) + (r.doc_type === 'credit' ? -1 : 1) * Number(r.amount);
}
const recent = mine.slice(-8);
return [{ json: {
  office_id: office.office_id,
  recent,
  numbers: issued.map((r) => r.doc_key),
  body: workerRequest({ ...office, committed }, recent, $('Config').first().json.OPENROUTER_MODEL),
} }];

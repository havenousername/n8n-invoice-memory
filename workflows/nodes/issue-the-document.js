// Glue for "Issue the document" in 00 Working day; worker.js, pdf.js, and OFFICES are pasted above it.
// The model only proposed the event. A rejected one throws its reason to the error output and the day moves on;
// an accepted one becomes a rendered PDF for 01b and a row for `issued`, the ground truth of the burst check.
const prep = $('Prepare the worker request').first().json;
const office = OFFICES.find((o) => o.office_id === prep.office_id);
let proposed;
try {
  proposed = JSON.parse($json.choices[0].message.content);
} catch {
  throw new Error('worker reply is not bare JSON');
}
const event = checkEvent(proposed, office, prep.recent, prep.slot);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const { doc, filename, resend_of } = toDocument(event, office, prep.recent, prep.numbers, now);
return [{ json: {
  filename,
  pdf_base64: Buffer.from(renderPdf(doc, office)).toString('base64'),
  office_id: office.office_id,
  manager_id: office.manager_id,
  worker_id: office.worker_id,
  issued: {
    issued_id: `iss_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    office_id: office.office_id, manager_id: office.manager_id, worker_id: office.worker_id,
    ...doc, category: doc.category || '', resend_of: resend_of || '', filename, issued_at: now,
  },
} }];

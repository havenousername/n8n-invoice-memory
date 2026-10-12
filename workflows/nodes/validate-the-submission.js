// Glue for "Validate the submission" in 01b Record a document. build_workflows.py pastes ids.js, OFFICES, and
// STATIC_DOCUMENTS (the booth pool, each PDF inlined) above it. Two inputs: a static `file` from the Form or the
// console, or a generated PDF from 00 Working day. Neither caller is trusted: a static file must be in the pool, and a
// generated one must name a known office, that office's worker, a well-formed file name, and carry a PDF.
const input = $json;
let doc;
if (input.file) {
  const meta = resolveDocument(input.file, STATIC_DOCUMENTS);
  doc = { ...meta, filename: input.file, pdf_base64: STATIC_DOCUMENTS[input.file].pdf_base64 };
} else {
  const office = OFFICES.find((o) => o.office_id === input.office_id);
  if (!office) throw new Error(`unknown office ${input.office_id}`);
  if (input.worker_id !== office.worker_id) throw new Error(`worker ${input.worker_id} does not file for ${office.office_id}`);
  const name = /^[a-z]{3}-(po|deal|cn)-\d+-v\d+(-copy)?\.pdf$/;
  if (typeof input.filename !== 'string' || !name.test(input.filename) || !input.filename.startsWith(`${office.code}-`)) {
    throw new Error(`bad filename ${input.filename}`);
  }
  if (typeof input.pdf_base64 !== 'string' || !input.pdf_base64.startsWith('JVBERi0')) throw new Error('not a PDF');
  doc = { office_id: office.office_id, manager_id: office.manager_id, worker_id: office.worker_id,
    filename: input.filename, pdf_base64: input.pdf_base64 };
}
const office = OFFICES.find((o) => o.office_id === doc.office_id);
return [{ json: {
  document_id: `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  office_id: doc.office_id,
  manager_id: doc.manager_id,
  worker_id: doc.worker_id,
  office_name: office.name,
  filename: doc.filename,
  pdf_base64: doc.pdf_base64,
  received_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
} }];

// Glue for "Build the rows" in 01b Record a document. Its input is the earlier document with the same PDF in this
// office, or the empty item from Always Output Data. A duplicate is recorded and never processed; a new document
// starts at stage 0 with its PDF in the row, so nothing downstream downloads it again.
const v = $('Validate the submission').first().json;
const original = $json.document_id ? $json : null;
return [{ json: {
  duplicate: !!original,
  original_filename: original ? original.filename : '',
  office: { office_id: v.office_id, manager_id: v.manager_id, name: v.office_name },
  row: {
    document_id: v.document_id,
    kind: original ? 'duplicate' : 'document',
    duplicate_of: original ? original.document_id : '',
    office_id: v.office_id,
    manager_id: v.manager_id,
    worker_id: v.worker_id,
    pdf_hash: $('Hash the PDF').first().json.pdf_hash,
    filename: v.filename,
    text: '',
    stage: 0,
    regex_fields: '{}',
    llm_fields: '{}',
    error: '',
    received_at: v.received_at,
    pdf_base64: v.pdf_base64,
  },
} }];

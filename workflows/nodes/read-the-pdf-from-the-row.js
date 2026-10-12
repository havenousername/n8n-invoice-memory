// Glue for "Read the PDF from the row" in 02 Process. The documents row holds the PDF; it becomes the binary that
// "Pull the text out of the PDF" reads. Nothing is downloaded.
const cfg = $('Config').first().json;
if (typeof cfg.pdf_base64 !== 'string' || !cfg.pdf_base64.startsWith('JVBERi0')) throw new Error(`no PDF in the row for ${cfg.document_id}`);
const data = await this.helpers.prepareBinaryData(Buffer.from(cfg.pdf_base64, 'base64'), cfg.filename, 'application/pdf');
return [{ json: { document_id: cfg.document_id }, binary: { data } }];

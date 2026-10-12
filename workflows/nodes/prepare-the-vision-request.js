// Glue for "Prepare the vision request" in 02 Process. build_workflows.py injects VISION_REQUEST_TEMPLATE above it:
// scripts/openrouter_check.py's extraction_body with an empty PDF, so n8n sends the request the live gate tested.
// The PDF comes from the row; the binary passes through for "Pull the text out of the PDF".
const cfg = $('Config').first().json;
const body = JSON.parse(JSON.stringify(VISION_REQUEST_TEMPLATE));
body.model = cfg.OPENROUTER_MODEL;
body.plugins[0].pdf.engine = cfg.PDF_ENGINE;
body.messages[1].content.find((part) => part.type === 'file').file.file_data += cfg.pdf_base64;
return [{ json: { body }, binary: $input.first().binary }];

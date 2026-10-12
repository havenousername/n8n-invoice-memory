// Glue for "Coarse read with regex" in 02 Process; coarse.js is pasted above it. Empty text (a scanned PDF) is valid.
const text = $json.text || '';
return [{ json: { regex_fields: JSON.stringify(coarseRead(text)), text } }];

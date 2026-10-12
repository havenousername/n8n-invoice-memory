// Glue for "Keep only the narrative" in 02b Write the summary. A bad reply stops the run: the office keeps its mechanical summary.
let reply;
try {
  reply = JSON.parse($json.choices[0].message.content);
} catch {
  throw new Error('narrative reply is not bare JSON');
}
if (!reply || typeof reply.narrative !== 'string' || reply.narrative.length < 20) throw new Error('bad narrative');
const revision = $('Prepare the narrative snapshot').first().json.payload.source_revision;
const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
return [{ json: { narrative: reply.narrative.slice(0, 600), at, revision } }];

// Glue for "Prepare the narrative snapshot" in 02b Write the summary.
// Only a sharp office is summarized: every document read by the vision stage, none pending, and no fresh summary yet.
// The payload travels on, so the summary is saved with the source_revision it was written from and goes stale when
// the rows change.
const cfg = $('Config').first().json;
const payload = (($json.result || [])[0] || {}).payload;
if (!payload || payload.manager_id !== cfg.manager_id || payload.office_id !== cfg.office_id) {
  throw new Error(`missing tenant point for ${cfg.manager_id}/${cfg.office_id}`);
}
if (payload.stage !== 2 || payload.pending_count !== 0 || payload.summary_stage === 3) return [];
const position = {
  committed: payload.committed, budget: payload.budget, used_pct: payload.used_pct,
  booked: payload.booked, deal_count: payload.deal_count,
  lines: payload.lines.map((l) => ({ category: l.name, budget: l.budget, committed: l.committed, credited: l.credited, over_by: l.over_by })),
};
const recent = payload.documents.filter((d) => d.kind !== 'duplicate').slice(-6)
  .map((d) => `${d.doc_key} v${d.version} | ${d.status} | ${d.doc_type} | ${d.category || '-'} | ${d.amount} EUR | ${d.description_en}`);
const body = {
  model: cfg.OPENROUTER_MODEL,
  temperature: 0,
  max_tokens: 300,
  response_format: { type: 'json_schema', json_schema: { name: 'narrative', strict: true, schema: {
    type: 'object', additionalProperties: false, required: ['narrative'], properties: { narrative: { type: 'string' } },
  } } },
  messages: [
    { role: 'system', content: 'You write for an event director at Q8nten, an event agency. Three plain sentences about this event: what sponsors and exhibitors have booked, what is committed against the production budget and which budget lines are over plan, and the most recent change, including amendments (a higher version replaces the older one). No bullet points.' },
    { role: 'user', content: `Event: ${payload.name}\nPosition: ${JSON.stringify(position)}\nRecent documents, oldest first:\n${recent.join('\n')}` },
  ],
};
return [{ json: { payload, body } }];

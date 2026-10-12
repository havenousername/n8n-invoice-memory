// Glue for "Validate the fields" in 02 Process; validate.js and OFFICES are pasted above it. A throw goes to the
// error output. The document must carry its own office's cost center.
const office = OFFICES.find((o) => o.office_id === $('Config').first().json.office_id);
if (!office) throw new Error(`unknown office ${$('Config').first().json.office_id}`);
let reply;
try {
  reply = JSON.parse($json.choices[0].message.content);
} catch {
  throw new Error('vision reply is not bare JSON');
}
return [{ json: { llm_fields: JSON.stringify(validateDocument(reply, office.cost_center)) } }];

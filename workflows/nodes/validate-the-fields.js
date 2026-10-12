// Glue for "Validate the fields" in 02 Process; validate.js is pasted above it. A throw goes to the error output.
let reply;
try {
  reply = JSON.parse($json.choices[0].message.content);
} catch {
  throw new Error('vision reply is not bare JSON');
}
return [{ json: { llm_fields: JSON.stringify(validateFields(reply)) } }];

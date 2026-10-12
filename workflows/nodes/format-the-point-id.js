// Glue for "Format the point id" in 02b Write the narrative; ids.js is pasted above it.
const cfg = $('Config').first().json;
const id = uuidFromHex($json.idhash);
return [{ json: { id, body: { shard_key: cfg.manager_id, ids: [id], with_payload: true } } }];

// Point ids and static document identity. Pasted into n8n Code nodes without the module.exports line.

function uuidFromHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{32,}$/i.test(hex)) {
    throw new Error(`expected a sha-256 hex digest, got ${hex}`);
  }
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// A static file's tenancy comes from the committed manifest, never from the request.
function resolveDocument(file, documents) {
  if (typeof file !== 'string' || !Object.hasOwn(documents, file)) throw new Error(`unknown document ${file}`);
  const d = documents[file];
  return { office_id: d.office_id, manager_id: d.manager_id, worker_id: d.worker_id, duplicate_of: d.duplicate_of || null };
}

module.exports = { uuidFromHex, resolveDocument };

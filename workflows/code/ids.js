// Point ids and upload identity. Pasted into n8n Code nodes without the module.exports line.

function uuidFromHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{32,}$/i.test(hex)) {
    throw new Error(`expected a sha-256 hex digest, got ${hex}`);
  }
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function resolveUpload(sampleFile, workerId, workers) {
  const slug = String(sampleFile).replace(/\.pdf$/i, '').split('-')[0].toLowerCase();
  if (!slug) throw new Error(`no customer slug in ${sampleFile}`);
  if (!Object.hasOwn(workers, workerId)) throw new Error(`unknown worker ${workerId}`);
  return { customer_id: slug, worker_id: workerId, manager_id: workers[workerId].manager_id };
}

module.exports = { uuidFromHex, resolveUpload };

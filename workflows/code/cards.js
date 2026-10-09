// Dashboard cards from Qdrant points. Pasted into n8n Code nodes without the module.exports line.

function shapeCards(points, workers) {
  return points.map(({ payload: q }) => {
    const worker = Object.hasOwn(workers, q.worker_id) ? workers[q.worker_id] : null;
    return {
      customer_id: q.customer_id,
      name: q.name,
      worker: (worker && worker.name) || q.worker_id,
      stage: q.stage,
      rung: q.summary_stage === 3 ? 3 : q.stage,
      pending_count: q.pending_count,
      invoice_count: q.invoice_count,
      open_amount: q.open_amount,
      overdue_count: q.overdue_count,
      overdue_amount: q.overdue_amount,
      latest: q.latest,
      narrative: q.summary_stage === 3 ? q.summary_text : '',
      updated_at: q.updated_at,
      deleted_at: q.deleted_at || null,
    };
  });
}

function splitRemoved(cards) {
  const plus30Days = (iso) => new Date(new Date(iso).getTime() + 30 * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    cards: cards.filter((c) => !c.deleted_at),
    removed: cards
      .filter((c) => c.deleted_at)
      .map((c) => ({ customer_id: c.customer_id, name: c.name, deleted_at: c.deleted_at, purge_at: plus30Days(c.deleted_at) })),
  };
}

module.exports = { shapeCards, splitRemoved };

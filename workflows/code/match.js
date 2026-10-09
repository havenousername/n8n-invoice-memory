// The invoice line shown under a search hit. Pasted into n8n Code nodes without the module.exports line.
// ponytail: MaxSim does not report which digest line won; token overlap is the cheap stand-in.

function pickMatchedLine(query, invoices) {
  const tokens = String(query).toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  let best = null;
  let bestScore = 0;
  for (const invoice of invoices || []) {
    const line = `${invoice.invoice_no || ''} ${invoice.vendor || ''} ${invoice.items || ''} ${invoice.status || ''}`.toLowerCase();
    const score = tokens.filter((t) => line.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = invoice;
    }
  }
  return best ? `${best.invoice_no} · ${best.items || best.vendor}` : null;
}

module.exports = { pickMatchedLine };

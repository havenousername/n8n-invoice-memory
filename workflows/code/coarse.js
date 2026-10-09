// Stage 1: a regex read of the extracted PDF text. Pasted into n8n Code nodes without the module.exports line.
// ponytail: deliberately naive. "4,250.00" parses right, "12.300,00" parses as 12.3; the vision stage corrects it.

function coarseRead(text) {
  const t = text || '';
  const grab = (re) => {
    const m = t.match(re);
    return m ? m[1].trim() : null;
  };
  const rawTotal = grab(/total[^0-9]*([0-9][0-9.,]*)/i);
  return {
    invoice_no: grab(/invoice\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9-]+)/i),
    date: grab(/(?<!due\s)date\s*:?\s*(\d{4}-\d{2}-\d{2})/i),
    due_date: grab(/due\s*(?:date)?\s*:?\s*(\d{4}-\d{2}-\d{2})/i),
    amount: rawTotal === null ? null : parseFloat(rawTotal.replace(/,/g, '')),
    vendor: grab(/from\s*:?\s*([^\n]+)/i),
  };
}

module.exports = { coarseRead };

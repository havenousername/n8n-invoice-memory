// Stage 1: a regex read of the extracted PDF text. Pasted into n8n Code nodes without the module.exports line.
// ponytail: deliberately naive about money. Commas are dropped, so the German "12.300,00 €" reads as 12.3;
// the vision stage corrects it. Every other field is read properly.

const COARSE_LABELS = ['Belegnummer', 'Version', 'Datum', 'Kostenstelle', 'Standort', 'Lieferant', 'Kunde', 'Kategorie',
  'Beschreibung', 'Betrag', 'Auftragswert', 'Eingereicht von', 'Synthetischer Beleg'];
// A value ends at the end of its line or where the next label starts, so flattened text reads the same.
const COARSE_UNTIL = `(?=\\s+(?:${COARSE_LABELS.join('|')})\\b|\\n|$)`;
const COARSE_TYPES = { BESTELLUNG: 'cost', KUNDENAUFTRAG: 'deal', GUTSCHRIFT: 'credit' };
const COARSE_CATEGORIES = {
  'Personal und Crew': 'people', 'Marketing und Werbung': 'cloud', 'Bühne und Technik': 'gpu',
  'Veranstaltungsort': 'office', 'Catering': 'travel',
};

function coarseRead(text) {
  const t = text || '';
  const grab = (re) => {
    const m = t.match(re);
    return m ? m[1].trim() : null;
  };
  const title = grab(/\b(BESTELLUNG|KUNDENAUFTRAG|GUTSCHRIFT)\b/);
  const version = grab(/Version:\s*(\d+)/);
  const date = t.match(/Datum:\s*(\d{2})\.(\d{2})\.(\d{4})/);
  const category = grab(new RegExp(`Kategorie:\\s*(.+?)${COARSE_UNTIL}`));
  const rawAmount = grab(/(?:Betrag|Auftragswert):\s*([0-9][0-9.,]*)/);
  return {
    doc_type: title ? COARSE_TYPES[title] : null,
    doc_key: grab(/Belegnummer:\s*((?:PO|DEAL|CN)-\d{4})/),
    version: version === null ? null : Number(version),
    date: date ? `${date[3]}-${date[2]}-${date[1]}` : null,
    cost_center: grab(/Kostenstelle:\s*(CC-[A-Z]{3}-\d{2})/),
    counterparty: grab(new RegExp(`(?:Lieferant|Kunde):\\s*(.+?)${COARSE_UNTIL}`)),
    category: category !== null && Object.hasOwn(COARSE_CATEGORIES, category) ? COARSE_CATEGORIES[category] : null,
    amount: rawAmount === null ? null : parseFloat(rawAmount.replace(/,/g, '')),
  };
}

module.exports = { coarseRead };

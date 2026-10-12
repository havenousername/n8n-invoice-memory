// A one-page German business document as a PDF, written by hand so it runs inside an n8n Code node.
// Pasted into Code nodes without the module.exports line. Deterministic: same input, same bytes.

const PDF_CATEGORY_LABELS = {
  people: 'Personal', cloud: 'Cloud-Infrastruktur', gpu: 'GPU-Rechenleistung',
  office: 'Büro und Ausstattung', travel: 'Reisen und Events',
};
const PDF_TITLES = { cost: 'BESTELLUNG', deal: 'KUNDENAUFTRAG', credit: 'GUTSCHRIFT' };
const PDF_FOOTER = 'Synthetischer Beleg für eine Demo. Keine echte Firma, keine echte Forderung.';
// WinAnsi bytes for characters outside Latin-1's printable range; Latin-1 itself maps one to one.
const PDF_WIN_ANSI = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97 };

function germanMoney(amount) {
  const [whole, cents] = Number(amount).toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents} €`;
}

function germanDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}.${m}.${y}`;
}

function wrapLine(prefix, text, width) {
  const lines = [];
  let line = prefix;
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line.length + word.length + 1 > width && line.trim() !== prefix.trim()) {
      lines.push(line.trimEnd());
      line = ' '.repeat(prefix.length);
    }
    line += word + ' ';
  }
  lines.push(line.trimEnd());
  return lines;
}

// The visible text, top to bottom: company, title, fields, and the footer as the last line.
function documentLines(doc, office) {
  const isDeal = doc.doc_type === 'deal';
  const lines = [
    'Q8nten GmbH',
    PDF_TITLES[doc.doc_type] || 'BELEG',
    `Belegnummer: ${doc.doc_key}`,
    doc.version > 1 ? `Version: ${doc.version} (ersetzt Version ${doc.version - 1})` : `Version: ${doc.version}`,
    `Datum: ${germanDate(doc.date)}`,
    `Kostenstelle: ${office.cost_center}`,
    `Standort: ${office.name}`,
    isDeal ? `Kunde: ${doc.counterparty}` : `Lieferant: ${doc.counterparty}`,
  ];
  if (!isDeal) lines.push(`Kategorie: ${PDF_CATEGORY_LABELS[doc.category] || doc.category}`);
  lines.push(...wrapLine('Beschreibung: ', doc.description_de, 78));
  lines.push(isDeal ? `Auftragswert: ${germanMoney(doc.amount)}` : `Betrag: ${germanMoney(doc.amount)}`);
  if (office.worker_name) lines.push(`Eingereicht von: ${office.worker_name}`);
  lines.push(PDF_FOOTER);
  return lines;
}

// PDF string literal, 7-bit clean: escapes for ( ) \ and octal for every byte above 0x7E.
function pdfText(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const byte = PDF_WIN_ANSI[ch] ?? (code >= 0x20 && code <= 0xff && !(code >= 0x7f && code <= 0x9f) ? code : 0x3f);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (byte > 0x7e) out += '\\' + byte.toString(8).padStart(3, '0');
    else out += String.fromCharCode(byte);
  }
  return `(${out})`;
}

function renderPdf(doc, office) {
  const lines = documentLines(doc, office);
  const footer = lines.pop();
  const ops = [];
  const show = (font, size, x, y, text) => ops.push(`BT /${font} ${size} Tf ${x} ${y} Td ${pdfText(text)} Tj ET`);
  show('F2', 13, 56, 790, lines[0]);
  show('F2', 22, 56, 750, lines[1]);
  ops.push('0.85 0.14 0.30 RG 1.5 w 56 735 m 539 735 l S');
  let y = 700;
  for (const line of lines.slice(2)) {
    const isAmount = /^(Betrag|Auftragswert):/.test(line);
    if (isAmount) y -= 10;
    show(isAmount ? 'F2' : 'F1', isAmount ? 14 : 11, 56, y, line);
    y -= isAmount ? 26 : 19;
  }
  show('F1', 8, 56, 60, footer);
  const stream = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let file = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = file.length;
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  file += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(file, (c) => c.charCodeAt(0));
}

module.exports = { germanMoney, germanDate, documentLines, renderPdf };

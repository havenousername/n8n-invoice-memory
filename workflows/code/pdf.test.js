const test = require('node:test');
const assert = require('node:assert');
const { germanMoney, germanDate, documentLines, renderPdf } = require('./pdf');

const BERLIN = { office_id: 'berlin', name: 'Berlin', cost_center: 'CC-BER-01', worker_name: 'Tom' };
const PO = {
  doc_type: 'cost', doc_key: 'PO-1042', version: 1, date: '2026-10-06', counterparty: 'Rechenwerk Systems GmbH',
  category: 'gpu', amount: 48000, description_de: 'GPU-Server (4x) für den Inferenz-Launch, Anzahlung',
};
const DEAL = { ...PO, doc_type: 'deal', doc_key: 'DEAL-3101', counterparty: 'Van Dijk Logistics B.V.', category: null, amount: 240000, description_de: 'Jahreslizenz Plattform' };
const CREDIT = { ...PO, doc_type: 'credit', doc_key: 'CN-4101', category: 'cloud', amount: 4800, description_de: 'Gutschrift für Ausfall' };
const text = (bytes) => String.fromCharCode(...bytes);

test('German money and dates', () => {
  assert.equal(germanMoney(12300), '12.300,00 €');
  assert.equal(germanMoney(1250.5), '1.250,50 €');
  assert.equal(germanMoney(240000), '240.000,00 €');
  assert.equal(germanDate('2026-10-05'), '05.10.2026');
});

test('a purchase commitment carries every German label', () => {
  const lines = documentLines(PO, BERLIN).join('\n');
  for (const s of ['Q8nten GmbH', 'BESTELLUNG', 'Belegnummer: PO-1042', 'Version: 1', 'Datum: 06.10.2026', 'Kostenstelle: CC-BER-01',
    'Lieferant: Rechenwerk Systems GmbH', 'Kategorie: GPU-Rechenleistung', 'Beschreibung: GPU-Server (4x) für den Inferenz-Launch, Anzahlung',
    'Betrag: 48.000,00 €', 'Synthetischer Beleg']) {
    assert.ok(lines.includes(s), s);
  }
});

test('an amendment says which version it replaces', () => {
  assert.ok(documentLines({ ...PO, version: 2 }, BERLIN).includes('Version: 2 (ersetzt Version 1)'));
});

test('a deal has a client, an order value, and no category', () => {
  const lines = documentLines(DEAL, BERLIN).join('\n');
  assert.ok(lines.includes('KUNDENAUFTRAG'));
  assert.ok(lines.includes('Kunde: Van Dijk Logistics B.V.'));
  assert.ok(lines.includes('Auftragswert: 240.000,00 €'));
  assert.ok(!lines.includes('Kategorie'));
  assert.ok(!lines.includes('Lieferant'));
});

test('a credit note is a Gutschrift with a supplier and a category', () => {
  const lines = documentLines(CREDIT, BERLIN).join('\n');
  assert.ok(lines.includes('GUTSCHRIFT'));
  assert.ok(lines.includes('Lieferant: Rechenwerk Systems GmbH'));
  assert.ok(lines.includes('Kategorie: Cloud-Infrastruktur'));
  assert.ok(lines.includes('Betrag: 4.800,00 €'));
});

test('long descriptions wrap below 80 characters', () => {
  const long = { ...PO, description_de: 'Wort '.repeat(40).trim() };
  for (const line of documentLines(long, BERLIN)) assert.ok(line.length <= 80, line);
});

test('rendering is deterministic and well formed', () => {
  const a = renderPdf(PO, BERLIN);
  const b = renderPdf(PO, BERLIN);
  assert.ok(a instanceof Uint8Array);
  assert.deepEqual(a, b);
  const s = text(a);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.ok(a.every((byte) => byte < 128), 'the file stays 7-bit; non-ASCII text uses octal escapes');
});

test('every xref offset points at its object', () => {
  const s = text(renderPdf(PO, BERLIN));
  const xref = s.slice(s.lastIndexOf('\nxref\n') + 1); // the table, not the "startxref" keyword
  const entries = xref.split('\n').slice(2).filter((l) => /^\d{10} \d{5} n/.test(l));
  assert.ok(entries.length >= 5);
  entries.forEach((entry, i) => {
    const offset = Number(entry.slice(0, 10));
    assert.ok(s.startsWith(`${i + 1} 0 obj`, offset), `object ${i + 1} at ${offset}`);
  });
  const startxref = Number(s.match(/startxref\s+(\d+)/)[1]);
  assert.ok(s.startsWith('xref', startxref));
});

test('umlauts and the euro sign are encoded for WinAnsi', () => {
  const s = text(renderPdf({ ...PO, description_de: 'Büro, Größe, Ärger, Öl, €' }, BERLIN));
  for (const escaped of ['\\374', '\\366', '\\337', '\\304', '\\326', '\\200']) assert.ok(s.includes(escaped), escaped);
  assert.ok(s.includes('/Encoding /WinAnsiEncoding'));
});

test('parentheses and backslashes in text are escaped', () => {
  const s = text(renderPdf({ ...PO, counterparty: 'A (B) \\ C' }, BERLIN));
  assert.ok(s.includes('A \\(B\\) \\\\ C'));
});

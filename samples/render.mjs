// Renders the static documents in manifest.json with the same writer the n8n AI workers use.
// Run after gen.py: node samples/render.mjs. A duplicate is a byte copy of its original.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderPdf } = require('../workflows/code/pdf.js');
const here = new URL('.', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, here), 'utf8'));

const offices = Object.fromEntries(read('offices.json').map((o) => [o.office_id, o]));
const manifest = read('manifest.json');
for (const doc of manifest.filter((d) => !d.duplicate_of)) {
  writeFileSync(new URL(doc.file, here), renderPdf(doc, offices[doc.office_id]));
}
for (const doc of manifest.filter((d) => d.duplicate_of)) {
  copyFileSync(new URL(doc.duplicate_of, here), new URL(doc.file, here));
}
console.log(`rendered ${manifest.length} PDFs`);

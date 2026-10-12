// Stage 2: validate what the vision model read. Pasted into n8n Code nodes without the module.exports line.

const DOCUMENT_TYPES = { cost: 'PO', deal: 'DEAL', credit: 'CN' };
const DOCUMENT_CATEGORIES = ['people', 'cloud', 'gpu', 'office', 'travel'];

// Formatted amounts: the later of "," and "." is the decimal point; a lone separator followed by exactly
// three digits is a thousands separator (EUR never has three decimals); repeated separators are thousands.
function toNumber(value) {
  if (typeof value === 'number') return value;
  const s = String(value ?? '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return NaN;
  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  if (commas && dots) {
    return Number(s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''));
  }
  if (!commas && !dots) return Number(s);
  const separator = commas ? ',' : '.';
  const digitsAfter = s.length - s.lastIndexOf(separator) - 1;
  const isThousands = commas + dots > 1 || digitsAfter === 3;
  return Number(isThousands ? s.split(separator).join('') : s.replace(separator, '.'));
}

function isCalendarDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function validateDocument(obj, expectedCostCenter) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('expected a JSON object');
  const docType = obj.doc_type;
  if (!Object.hasOwn(DOCUMENT_TYPES, docType)) throw new Error(`bad doc_type ${docType}`);
  const docKey = String(obj.doc_key ?? '').trim();
  if (!/^(PO|DEAL|CN)-\d{4}$/.test(docKey) || !docKey.startsWith(DOCUMENT_TYPES[docType] + '-')) {
    throw new Error(`bad doc_key ${obj.doc_key} for ${docType}`);
  }
  const version = Number(obj.version);
  if (!Number.isInteger(version) || version < 1) throw new Error(`bad version ${obj.version}`);
  const date = String(obj.date ?? '');
  if (!isCalendarDate(date)) throw new Error(`bad date ${obj.date}`);
  const rawCategory = obj.category === null || obj.category === undefined ? 'none' : String(obj.category);
  const category = docType === 'deal'
    ? (rawCategory === 'none' || rawCategory === '' ? null : undefined)
    : (DOCUMENT_CATEGORIES.includes(rawCategory) ? rawCategory : undefined);
  if (category === undefined) throw new Error(`bad category ${obj.category} for ${docType}`);
  const amount = toNumber(obj.amount);
  if (!Number.isFinite(amount)) throw new Error(`amount not numeric: ${obj.amount}`);
  if (amount <= 0) throw new Error(`amount must be positive: ${obj.amount}`);
  const counterparty = String(obj.counterparty ?? '').trim();
  if (!counterparty) throw new Error('missing counterparty');
  const description = String(obj.description_en ?? '').trim();
  if (!description) throw new Error('missing description_en');
  const costCenter = String(obj.cost_center ?? '').trim().toUpperCase();
  if (costCenter !== String(expectedCostCenter).toUpperCase()) {
    throw new Error(`cost center mismatch: read ${obj.cost_center}, expected ${expectedCostCenter}`);
  }
  return {
    doc_type: docType, doc_key: docKey, version, cost_center: costCenter, date, counterparty, category, amount,
    description_en: description.slice(0, 160),
  };
}

module.exports = { toNumber, validateDocument };

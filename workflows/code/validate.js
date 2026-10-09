// Stage 2: validate what the vision model returned. Pasted into n8n Code nodes without the module.exports line.

const INVOICE_STATUSES = ['open', 'paid', 'overdue'];
const REQUIRED_INVOICE_FIELDS = ['invoice_no', 'date', 'due_date', 'amount', 'vendor', 'customer_name', 'status'];

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

function validateFields(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('expected a JSON object');
  for (const key of REQUIRED_INVOICE_FIELDS) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') throw new Error(`missing ${key}`);
  }
  const amount = toNumber(obj.amount);
  if (!Number.isFinite(amount)) throw new Error(`amount not numeric: ${obj.amount}`);
  const status = String(obj.status).trim().toLowerCase();
  if (!INVOICE_STATUSES.includes(status)) throw new Error(`bad status ${obj.status}`);
  for (const key of ['date', 'due_date']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(obj[key])) throw new Error(`bad ${key} ${obj[key]}`);
  }
  return {
    invoice_no: String(obj.invoice_no),
    date: obj.date,
    due_date: obj.due_date,
    amount,
    vendor: String(obj.vendor),
    customer_name: String(obj.customer_name),
    status,
    line_items_summary: String(obj.line_items_summary || '').slice(0, 120),
  };
}

module.exports = { toNumber, validateFields };

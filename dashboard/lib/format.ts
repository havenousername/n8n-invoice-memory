// Display formats for the booth screen: English UI, euro amounts with the sign after.

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function euro(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  return `${Number.isInteger(amount) ? grouped.format(amount) : cents.format(amount)} €`;
}

export function compactEuro(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) return `${Math.round(amount / 10_000) / 100} M €`;
  if (Math.abs(amount) >= 10_000) return `${Math.round(amount / 1000)} k €`;
  return euro(Math.round(amount));
}

export function clock(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone });
}

export function stageName(stage: number): string {
  return ({ 0: 'received', 1: 'rough read', 2: 'sharp', [-1]: 'error' } as Record<number, string>)[stage] ?? 'unknown';
}

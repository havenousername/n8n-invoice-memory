// The booth documents the Console can send; 01b checks the same list again. Mirrors samples/manifest.json.
export const BOOTH_POOL = [
  { file: 'ber-po-1042-v1.pdf', office: 'Berlin', label: 'PO-1042 v1 · GPU servers, deposit · 48,000 €' },
  { file: 'ber-po-1042-v2.pdf', office: 'Berlin', label: 'PO-1042 v2 · order expanded to 11 servers · 132,000 €' },
  { file: 'muc-po-2041-v1.pdf', office: 'Munich', label: 'PO-2041 v1 · Hetzner staging servers · 12,300 €' },
  { file: 'ber-po-1042-v1-copy.pdf', office: 'Berlin', label: 'PO-1042 v1 again · the same file, resent' },
] as const;

export const isPoolFile = (file: unknown): file is string => BOOTH_POOL.some((d) => d.file === file);

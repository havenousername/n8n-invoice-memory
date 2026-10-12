// The booth documents the Console can send; 01b checks the same list again. Mirrors samples/manifest.json.
export const BOOTH_POOL = [
  { file: 'ber-po-1042-v1.pdf', office: 'DevSummit Berlin', label: 'PO-1042 v1 · main stage light and sound, deposit · 48,000 €' },
  { file: 'ber-po-1042-v2.pdf', office: 'DevSummit Berlin', label: 'PO-1042 v2 · two LED walls and a sponsor keynote stage · 132,000 €' },
  { file: 'muc-po-2041-v1.pdf', office: 'CloudTage München', label: 'PO-2041 v1 · catering for day 1, 300 guests · 12,300 €' },
  { file: 'ber-po-1042-v1-copy.pdf', office: 'DevSummit Berlin', label: 'PO-1042 v1 again · the same contract, sent twice' },
] as const;

export const isPoolFile = (file: unknown): file is string => BOOTH_POOL.some((d) => d.file === file);

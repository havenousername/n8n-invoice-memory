// An office's committed position over time, replayed from the documents on its point in arrival order:
// a commitment steps up, a credit note steps down, an amendment replaces its older version, a duplicate,
// a deal, or a late older version leaves the line flat. Same rules as the office view in n8n.
import { euro } from './format';
import type { DocumentEntry, OfficeCard } from './shape';

export type TimelineKind = 'start' | 'commit' | 'credit' | 'amend' | 'duplicate' | 'deal' | 'late';
export type TimelinePoint = {
  t: number; committed: number; pct: number; kind: TimelineKind; over: boolean;
  doc_key: string | null; version: number | null; label: string;
};

export function officeTimeline(card: OfficeCard, startMs: number): TimelinePoint[] {
  const budgets = Object.fromEntries(card.lines.map((l) => [l.category, { budget: l.budget, name: l.name }]));
  const current = new Map<string, DocumentEntry>();
  const points: TimelinePoint[] = [{ t: startMs, committed: 0, pct: 0, kind: 'start', over: false, doc_key: null, version: null, label: '' }];
  let committed = 0;
  let overNames: string[] = [];

  const position = () => {
    const costs: Record<string, number> = {};
    const credits: Record<string, number> = {};
    for (const d of current.values()) {
      if (!d.category || d.amount === null) continue;
      if (d.doc_type === 'cost') costs[d.category] = (costs[d.category] ?? 0) + d.amount;
      if (d.doc_type === 'credit') credits[d.category] = (credits[d.category] ?? 0) + d.amount;
    }
    let total = 0;
    const over: string[] = [];
    for (const category of new Set([...Object.keys(costs), ...Object.keys(credits)])) {
      const net = Math.max(0, (costs[category] ?? 0) - (credits[category] ?? 0));
      total += net;
      if (budgets[category] && net > budgets[category].budget) over.push(budgets[category].name);
    }
    return { total, over };
  };

  const ordered = [...card.documents].sort((a, b) => a.received_at.localeCompare(b.received_at));
  for (const d of ordered) {
    let kind: TimelineKind;
    if (d.kind === 'duplicate') kind = 'duplicate';
    else if (!d.doc_key || d.stage === 0) continue;
    else {
      const held = current.get(d.doc_key);
      if (held && (d.version ?? 0) <= (held.version ?? 0)) kind = 'late';
      else {
        kind = held ? 'amend' : d.doc_type === 'deal' ? 'deal' : d.doc_type === 'credit' ? 'credit' : 'commit';
        current.set(d.doc_key, d);
        ({ total: committed, over: overNames } = position());
      }
    }
    points.push({
      t: Date.parse(d.received_at), committed, pct: card.budget ? (committed / card.budget) * 100 : 0, kind,
      over: overNames.length > 0, doc_key: d.doc_key, version: d.version, label: describe(kind, d, committed, overNames),
    });
  }
  return points;
}

function describe(kind: TimelineKind, d: DocumentEntry, committed: number, over: string[]): string {
  const key = `${d.doc_key} v${d.version}`;
  const tail = over.length ? `, ${over.join(' and ')} over plan` : '';
  switch (kind) {
    case 'amend': return `${d.doc_key} v${d.version} replaces v${(d.version ?? 2) - 1}: ${euro(d.amount)}${tail}`;
    case 'credit': return `${key} credit note: −${euro(d.amount)}, ${euro(committed)} committed${tail}`;
    case 'deal': return `${key} customer order booked: ${euro(d.amount)}, money in`;
    case 'duplicate': return `${d.filename ?? 'a file'} again: duplicate, not summed`;
    case 'late': return `${key} arrived after a newer version: kept, not summed`;
    default: return `${key}: +${euro(d.amount)}, ${euro(committed)} committed${tail}`;
  }
}

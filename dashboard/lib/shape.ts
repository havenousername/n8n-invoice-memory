// Office points as the views use them: cards with rated budget lines, Ask results per lens, the newest document.

export type Line = { category: string; name: string; budget: number; committed: number; credited: number; remaining: number; over_by: number };

export type DocumentEntry = {
  document_id: string; kind: 'document' | 'duplicate'; duplicate_of: string | null; filename: string | null;
  doc_type: 'cost' | 'deal' | 'credit' | null; doc_key: string | null; version: number | null; counterparty: string | null;
  category: string | null; amount: number | null; description_en: string | null; date: string | null;
  stage: number; error: string; received_at: string; status: 'current' | 'superseded' | 'duplicate' | 'pending';
};

export type Latest = {
  document_id: string; kind: string; doc_type: string | null; doc_key: string | null; version: number | null;
  stage: number; amount: number | null; status: string; received_at: string;
};

export type OfficePayload = {
  office_id: string; manager_id: string; name: string; region: string; stage: number; pending_count: number;
  lines: Line[]; budget: number; committed: number; used_pct: number; booked: number; deal_count: number;
  documents: DocumentEntry[]; superseded_count: number; duplicate_count: number; latest: Latest | null;
  source_revision: string; summary_stage: number; summary_text: string; summary_generated_at: string; updated_at: string;
};

export type LineStatus = 'within' | 'near' | 'over';
export type RatedLine = Line & { status: LineStatus; used: number };
export type OfficeCard = Omit<OfficePayload, 'lines'> & { point_id: string; lines: RatedLine[]; over_count: number };
export type LensHit = { office_id: string; name: string; score: number; matched: string | null };
export type LensResults = { keyword: LensHit[]; line: LensHit[]; meaning: LensHit[]; fused: LensHit[] };
export type LatestDocument = Latest & { office_id: string; office_name: string; manager_id: string };

export const NEAR_PLAN = 0.85;

function rate(line: Line): RatedLine {
  const used = line.budget > 0 ? line.committed / line.budget : 0;
  const status: LineStatus = line.over_by > 0 ? 'over' : used >= NEAR_PLAN ? 'near' : 'within';
  return { ...line, status, used };
}

export function toOfficeCard(point: { id: string | number; payload: OfficePayload }): OfficeCard {
  const { lines, ...rest } = point.payload;
  const rated = lines.map(rate);
  return { ...rest, point_id: String(point.id), lines: rated, over_count: rated.filter((l) => l.status === 'over').length };
}

const words = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));

/** The current document line (or summary sentence) sharing the most words with the query, for "why this office". */
export function matchedLine(payload: Pick<OfficePayload, 'documents' | 'summary_text'>, query: string): string | null {
  const asked = words(query);
  const candidates = [
    ...payload.documents.filter((d) => d.status === 'current').reverse()
      .map((d) => [d.doc_key, d.counterparty, d.description_en].filter(Boolean).join(' · ')),
    ...(payload.summary_text || '').split(/(?<=[.!?])\s+/).filter(Boolean),
  ];
  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const have = words(candidate);
    const score = [...asked].filter((w) => have.has(w)).length;
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}

type Hit = { id: string | number; score: number; payload: Pick<OfficePayload, 'office_id' | 'name' | 'documents' | 'summary_text'> };

export function toLensResults(batch: { points: Hit[] }[], query: string): LensResults {
  if (!Array.isArray(batch) || batch.length !== 4) throw new Error('expected four searches: keyword, line, meaning, fused');
  const hits = (points: Hit[]) => points.map((p) => ({
    office_id: p.payload.office_id, name: p.payload.name, score: p.score, matched: matchedLine(p.payload, query),
  }));
  const [keyword, line, meaning, fused] = batch.map((r) => hits(r.points));
  return { keyword, line, meaning, fused };
}

/** The newest received document across the manager's offices, for the latest-document band. */
export function latestAcross(cards: OfficeCard[]): LatestDocument | null {
  let newest: LatestDocument | null = null;
  for (const card of cards) {
    if (card.latest && (!newest || card.latest.received_at > newest.received_at)) {
      newest = { ...card.latest, office_id: card.office_id, office_name: card.name, manager_id: card.manager_id };
    }
  }
  return newest;
}

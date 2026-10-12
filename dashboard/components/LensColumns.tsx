import { FileText, Sparkles } from 'lucide-react';
import type { LensHit, LensResults, MatchedDocument } from '@/lib/shape';

export const LENSES = [
  { key: 'summary', name: 'From the summary', short: 'Summary', Icon: Sparkles, color: 'var(--lens-keyword)', hex: '#039be5',
    how: 'hybrid search, three vectors fused' },
  { key: 'pdf', name: 'From the PDF', short: 'PDF', Icon: FileText, color: 'var(--lens-line)', hex: '#7c66ff',
    how: 'ColBERT, word by word' },
] as const;
export type LensKey = (typeof LENSES)[number]['key'];

/** The top hit of each lens: summary from the fused ranking, PDF from the ColBERT search. */
export function topHits(lenses: LensResults): Record<LensKey, LensHit | undefined> {
  return { summary: lenses.fused[0], pdf: lenses.line[0] };
}

/** One lens at a time, like a switch on a tour: the answer big, the runners-up as plain names. */
export function LensAnswer({ lenses, lens }: { lenses: LensResults; lens: LensKey }) {
  const hits = lens === 'summary' ? lenses.fused : lenses.line;
  const meta = LENSES.find((l) => l.key === lens)!;
  const [best, ...rest] = hits;
  if (!best) return <p className="empty">No office matches.</p>;
  return (
    <div key={lens} className="answer" style={{ ['--lens-color' as string]: meta.color }}>
      <p className="answer-how">{meta.how}</p>
      <p className="answer-office">{best.name}</p>
      <p className="answer-line">{lens === 'pdf'
        ? (best.document ? <Highlight doc={best.document} /> : 'no document shares a word with the question')
        : best.sentence ?? '—'}</p>
      {rest.length > 0 && <p className="answer-rest">then {rest.slice(0, 2).map((h) => h.name).join(' · ')}</p>}
    </div>
  );
}

/** The document line with the question's words marked, so the ColBERT match is visible word by word. */
function Highlight({ doc }: { doc: MatchedDocument }) {
  const marked = new Set(doc.words);
  return (
    <span className="mono-line">
      {doc.text.split(/([^\p{L}\p{N}]+)/u).map((part, i) =>
        marked.has(part.toLowerCase()) ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>)}
    </span>
  );
}


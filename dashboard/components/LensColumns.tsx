import { Combine } from 'lucide-react';
import type { LensHit, LensResults } from '@/lib/shape';

export const LENSES = [
  { key: 'keyword', name: 'Keyword', vector: 'bm25', what: 'exact codes and names' },
  { key: 'line', name: 'Line', vector: 'ColBERT', what: 'one specific line' },
  { key: 'meaning', name: 'Meaning', vector: 'dense', what: 'the overall situation' },
] as const;

const COLOR = { keyword: 'var(--lens-keyword)', line: 'var(--lens-line)', meaning: 'var(--lens-meaning)' };

/** Three representations side by side, then the fused ranking Qdrant computed from all three. */
export function LensColumns({ lenses, tookMs }: { lenses: LensResults; tookMs: number }) {
  return (
    <>
      <div className="lenses">
        {LENSES.map((lens) => (
          <section key={lens.key} id={`lens-${lens.key}`} className="lens" style={{ ['--lens-color' as string]: COLOR[lens.key] }}>
            <h3>{lens.name} <span>{lens.vector}</span></h3>
            <p className="what">{lens.what}</p>
            <Hits hits={lenses[lens.key]} />
          </section>
        ))}
      </div>
      <section className="fused" aria-label="Fused result">
        <h3><Combine size={18} aria-hidden="true" /> Fused: one request, three lenses, ranked by RRF</h3>
        {lenses.fused.length ? (
          <ol>{lenses.fused.slice(0, 3).map((hit) => <li key={hit.office_id}><b>{hit.name}</b>{hit.matched && <span className="matched">{hit.matched}</span>}</li>)}</ol>
        ) : <p className="empty">No office matches.</p>}
      </section>
      <p className="answer-meta"><span>answered in <b className="num">{tookMs} ms</b></span><span><b>no model called</b>: the representations were stored when each document was read</span></p>
    </>
  );
}

function Hits({ hits }: { hits: LensHit[] }) {
  if (!hits.length) return <p className="empty">no match</p>;
  return (
    <ol>
      {hits.slice(0, 3).map((hit) => (
        <li key={hit.office_id} title={hit.matched ?? undefined}>
          <span>{hit.name}<span className="matched">{hit.matched ?? ''}</span></span>
          <span className="score num">{hit.score.toFixed(2)}</span>
        </li>
      ))}
    </ol>
  );
}

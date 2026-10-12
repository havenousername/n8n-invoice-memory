'use client';
import { Copy, Database, Handshake, History, LoaderCircle, Sparkles } from 'lucide-react';
import type { CSSProperties } from 'react';
import { euro } from '@/lib/format';
import { CONTROLLERS } from '@/lib/offices';
import type { OfficeCard as Card } from '@/lib/shape';
import type { SeenEvent } from '@/lib/spotlight';
import { Meters, type Flow } from './Meters';
import { Typewriter } from './motion';

const LENS_COLOR = { keyword: 'var(--lens-keyword)', line: 'var(--lens-line)', meaning: 'var(--lens-meaning)' };

type Props = { card: Card; flash?: SeenEvent; dim: boolean; lens?: keyof typeof LENS_COLOR; fused: boolean };

/** One Qdrant point: an office's budget lines, counts, and cached summary, all in one place. */
export function OfficeCard({ card, flash, dim, lens, fused }: Props) {
  const reading = card.pending_count > 0;
  const fresh = card.summary_stage === 3;
  const flashKey = flash ? `${flash.kind}-${flash.document_id ?? ''}-${flash.seenAt}` : null;
  const flow = flash?.kind === 'corrected' ? flowFor(card, flash) : undefined;
  const superseded = flash?.kind === 'superseded' ? card.documents.find((d) => d.document_id === flash.document_id) : undefined;
  return (
    <article id={`card-${card.office_id}`} className={`panel office${dim ? ' dim' : ''}`} data-flash={flash?.kind}
      data-lens={lens} data-fused={fused ? 1 : undefined}
      style={lens ? ({ '--lens-color': LENS_COLOR[lens] } as CSSProperties) : undefined}
      aria-label={`${card.name} office`}>
      {flashKey && <span key={flashKey} className="flash-ring" aria-hidden="true" />}
      {flash?.kind === 'duplicate' && <span key={flashKey} className="stamp dup-stamp" aria-hidden="true">Seen before</span>}
      <header className="office-head">
        <span className="office-name">{card.name}</span>
        <span className="office-meta">{card.region} · {CONTROLLERS[card.office_id] ?? ''}</span>
        <span className="grow" />
        {reading
          ? <span className="chip" data-tone="rough"><LoaderCircle size={14} aria-hidden="true" /> reading {card.pending_count}</span>
          : card.documents.length > 0 && <span className="chip" data-tone="sharp">sharp</span>}
        <span className="chip" title="Everything about this office lives in one Qdrant point"><Database size={14} aria-hidden="true" /> 1 point</span>
      </header>
      <Meters lines={card.lines} flow={flow} />
      <div className="counts">
        <span><b className="num">{card.documents.filter((d) => d.kind === 'document').length}</b> documents</span>
        <span><Handshake size={16} aria-hidden="true" /> <b className="num">{euro(card.booked)}</b> booked</span>
        <span title="Older versions: kept, never summed"><History size={16} aria-hidden="true" /> <b className="num">{card.superseded_count}</b> superseded</span>
        <span title="Same bytes again: counted once"><Copy size={16} aria-hidden="true" /> <b className="num">{card.duplicate_count}</b> duplicates</span>
        {superseded && <span key={flashKey} className="history-chip num">{superseded.doc_key} v{superseded.version} {euro(superseded.amount)}</span>}
      </div>
      <p className={`summary${reading ? ' blurred' : ''}`} data-fresh={fresh}>
        <Typewriter text={card.summary_text || 'No documents yet.'} play={flash?.kind === 'summary' ? flashKey : null} />
      </p>
      <span className="fresh" data-fresh={fresh}>
        <Sparkles size={14} aria-hidden="true" />
        {fresh ? 'summary written once, served from memory' : reading ? 'summary waits for every document to be read' : 'mechanical summary until the next sharp read'}
      </span>
    </article>
  );
}

function flowFor(card: Card, flash: SeenEvent): Flow | undefined {
  const doc = card.documents.find((d) => d.document_id === flash.document_id);
  if (!doc || !doc.category || doc.amount === null || doc.doc_type === 'deal') return undefined;
  const credit = doc.doc_type === 'credit';
  return { category: doc.category, text: `${credit ? '−' : '+'}${euro(doc.amount)}`, kind: credit ? 'credit' : 'cost', key: `${flash.seenAt}` };
}

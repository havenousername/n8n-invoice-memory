'use client';
import { CircleAlert, Database, Handshake, Sparkles, Wallet } from 'lucide-react';
import { compactEuro, euro } from '@/lib/format';
import type { OfficeCard } from '@/lib/shape';
import { CountUp } from './motion';

type Props = { cards: OfficeCard[]; overOnly: boolean; onOverOnly: () => void; served: number; tookMs: number | null };

/** The manager's whole position at a glance; "lines over plan" filters the office map. */
export function Tiles({ cards, overOnly, onOverOnly, served, tookMs }: Props) {
  const budget = cards.reduce((s, c) => s + c.budget, 0);
  const committed = cards.reduce((s, c) => s + c.committed, 0);
  const over = cards.reduce((s, c) => s + c.over_count, 0);
  const booked = cards.reduce((s, c) => s + c.booked, 0);
  const deals = cards.reduce((s, c) => s + c.deal_count, 0);
  const fresh = cards.filter((c) => c.summary_stage === 3).length;
  return (
    <div className="tiles">
      <div className="tile">
        <span className="tile-label"><Wallet size={18} aria-hidden="true" /> Committed against budget</span>
        <span className="tile-value num"><CountUp value={committed} format={compactEuro} /> <small>/ {compactEuro(budget)}</small></span>
        <span className="bar"><span style={{ transform: `scaleX(${budget ? Math.min(1, committed / budget) : 0})` }} /></span>
      </div>
      <button type="button" className="tile" aria-pressed={overOnly} onClick={onOverOnly}>
        <span className="tile-label"><CircleAlert size={18} aria-hidden="true" /> Lines over plan</span>
        <span className="tile-value num">{over}</span>
        <span className="tile-note">{overOnly ? 'showing only offices over plan' : 'click to show only those offices'}</span>
      </button>
      <div className="tile">
        <span className="tile-label"><Handshake size={18} aria-hidden="true" /> Deals booked</span>
        <span className="tile-value num"><CountUp value={booked} format={compactEuro} /></span>
        <span className="tile-note">{deals} client {deals === 1 ? 'deal' : 'deals'}</span>
      </div>
      <div className="tile">
        <span className="tile-label"><Sparkles size={18} aria-hidden="true" /> Summaries current</span>
        <span className="tile-value num">{fresh} <small>/ {cards.length}</small></span>
        <span className="tile-note">a summary is rewritten only when its office changes</span>
      </div>
      <div className="tile">
        <span className="tile-label"><Database size={18} aria-hidden="true" /> Served from memory</span>
        <span className="tile-value num"><CountUp value={served} format={(n) => euro(Math.round(n)).replace(' €', '')} /> <small>answers</small></span>
        <span className="tile-note">0 model calls{tookMs !== null && <>, last one in <span className="num">{tookMs} ms</span></>}</span>
      </div>
    </div>
  );
}

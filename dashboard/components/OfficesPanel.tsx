'use client';
// The offices canvas, with a switch like the hyperbolic tour's: Chart shows one line per office (percent of its
// budget committed, replayed from its point); Point opens one office's Qdrant point (payload and three vectors).
// The info boxes beside it hold each office's cached summary; clicking a line or a box opens that point.
import { CircleAlert, LoaderCircle, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { clock, compactEuro, euro } from '@/lib/format';
import { pointAnatomy } from '@/lib/point';
import type { OfficeCard } from '@/lib/shape';
import type { SeenEvent } from '@/lib/spotlight';
import { summaryStatus, type SummaryStatus } from '@/lib/summary';
import { officeTimeline, type TimelinePoint } from '@/lib/timeline';
import type { LensKey } from './LensColumns';
import { Typewriter } from './motion';

/** Office line colors, validated as a categorical trio on the panel surface (dataviz palette check). */
export const OFFICE_COLORS = ['#c08a00', '#b45ad0', '#1a9fa8'];
const LENS_COLOR: Record<LensKey, string> = { summary: 'var(--lens-keyword)', pdf: 'var(--lens-line)' };

export type OfficeView = { mode: 'chart' } | { mode: 'point'; office: string; pinned: boolean };

type Props = {
  cards: (OfficeCard | null)[]; now: number; view: OfficeView; onView: (view: OfficeView) => void;
  flashFor: (office: string) => SeenEvent | undefined;
  lensFor: (office: string) => LensKey | undefined;
};

export function OfficesPanel({ cards, now, view, onView, flashFor, lensFor }: Props) {
  const shown = cards.filter((c): c is OfficeCard => c !== null);
  const colorOf = (office: string) => OFFICE_COLORS[Math.max(0, shown.findIndex((c) => c.office_id === office))];
  const pointCard = view.mode === 'point' ? shown.find((c) => c.office_id === view.office) : undefined;
  const open = (office: string) => onView({ mode: 'point', office, pinned: true });
  return (
    <section className="panel offices" aria-label="Events">
      <header className="canvas-head">
        <p className="eyebrow">Events · one Qdrant point each</p>
        <div className="switch" role="tablist" aria-label="Events view">
          <button type="button" role="tab" aria-selected={view.mode === 'chart'} onClick={() => onView({ mode: 'chart' })}>Chart</button>
          <button type="button" role="tab" aria-selected={view.mode === 'point'}
            onClick={() => shown[0] && open(view.mode === 'point' ? view.office : shown[0].office_id)}>Point</button>
        </div>
        <span className="hint"><b>{view.mode === 'chart' ? 'Click an event.' : 'This is everything Qdrant holds about it.'}</b></span>
      </header>
      <div className="offices-body">
        {pointCard
          ? <PointView key={pointCard.office_id} card={pointCard} color={colorOf(pointCard.office_id)} status={summaryStatus(pointCard, now)} />
          : <OfficeChart cards={shown} now={now} onOpen={open} />}
        <div className="boxes">
          {cards.map((card, i) => card
            ? <OfficeBox key={card.office_id} card={card} color={OFFICE_COLORS[i]} flash={flashFor(card.office_id)} status={summaryStatus(card, now)}
                lens={lensFor(card.office_id)} selected={pointCard?.office_id === card.office_id} onOpen={() => open(card.office_id)} />
            : <div key={`empty-${i}`} className="skeleton box" aria-hidden="true" />)}
        </div>
      </div>
    </section>
  );
}

type Size = { w: number; h: number };
const PAD = { left: 52, right: 240, top: 14, bottom: 30 };

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function OfficeChart({ cards, now, onOpen }: { cards: OfficeCard[]; now: number; onOpen: (office: string) => void }) {
  const [box, { w, h }] = useSize();
  // The axis spans the documents, not the idle hour after them: it ends a little after the newest document
  // (the lines run on to the edge, which reads as "now") and grows with every new one.
  const times = cards.flatMap((c) => c.documents.map((d) => Date.parse(d.received_at))).filter(Number.isFinite);
  const first = times.length ? Math.min(...times) : now - 10 * 60_000;
  const newest = times.length ? Math.max(...times) : now;
  const span = Math.max(3 * 60_000, newest - first);
  const end = Math.min(Math.max(now, newest), newest + span * 0.25);
  const start = first - span * 0.06;
  const series = cards.map((card, i) => ({ card, color: OFFICE_COLORS[i], points: officeTimeline(card, start) }));
  const top = niceMax(Math.max(5, ...series.flatMap((s) => s.points.map((p) => p.pct))) * 1.15);
  const x = (t: number) => PAD.left + ((t - start) / Math.max(1, end - start)) * (w - PAD.left - PAD.right);
  const y = (pct: number) => PAD.top + (1 - pct / top) * (h - PAD.top - PAD.bottom);
  const ticksX = [0, 0.33, 0.66, 1].map((f) => start + f * (end - start));
  const labels = placeLabels(series.map((s) => ({ key: s.card.office_id, y: y(last(s.points).pct) })), h);
  return (
    <div className="chart-box" ref={box}>
      {w > 0 && (
        <svg width={w} height={h} role="img" aria-label="Percent of each event's production budget committed over time">
          {[0, top / 2, top].map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} className="grid" />
              <text x={PAD.left - 10} y={y(v) + 5} className="axis" textAnchor="end">{v}%</text>
            </g>
          ))}
          {ticksX.map((t, i) => (
            <text key={i} x={x(t)} y={h - 8} className="axis" textAnchor="middle">{i === ticksX.length - 1 ? 'now' : clock(new Date(t).toISOString()).slice(0, 5)}</text>
          ))}
          {series.map(({ card, color, points }) => (
            <OfficeLine key={card.office_id} id={card.office_id} color={color} points={points} x={x} y={y} endX={x(end)} onOpen={() => onOpen(card.office_id)} />
          ))}
          {series.map(({ card, color, points }) => (
            <text key={card.office_id} x={x(end) + 10} y={(labels[card.office_id] ?? y(last(points).pct)) + 5} className="end-label" fill={color}
              onClick={() => onOpen(card.office_id)}>
              {card.name} <tspan className="end-pct">{last(points).pct.toFixed(1)}%</tspan>
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

type Scale = (v: number) => number;

function OfficeLine({ id, color, points, x, y, endX, onOpen }: { id: string; color: string; points: TimelinePoint[]; x: Scale; y: Scale; endX: number; onOpen: () => void }) {
  const steps = (pts: TimelinePoint[]) => pts.map((p, i) => (i === 0 ? `M ${x(p.t)} ${y(p.pct)}` : `H ${x(p.t)} V ${y(p.pct)}`)).join(' ');
  const before = points.slice(0, -1);
  const newest = last(points);
  const from = before.length ? last(before) : newest;
  const lastSegment = `M ${x(from.t)} ${y(from.pct)} H ${x(newest.t)} V ${y(newest.pct)} H ${endX}`;
  const overAt = points.findLastIndex((p) => p.over);
  return (
    <g style={{ '--line': color } as CSSProperties} className="office-series" onClick={onOpen}>
      <path d={`${steps(points)} H ${endX}`} className="hit" />
      {before.length > 0 && <path d={steps(before)} className="office-line" />}
      <path key={`${id}-${points.length}`} d={lastSegment} className="office-line draw-in" />
      {points.slice(1).map((p, i) => <Marker key={`${p.t}-${i}`} p={p} cx={x(p.t)} cy={y(p.pct)} fresh={i === points.length - 2} />)}
      {overAt > 0 && <text x={x(points[overAt].t) + 12} y={y(points[overAt].pct) - 12} className="over-label">over plan</text>}
    </g>
  );
}

function Marker({ p, cx, cy, fresh }: { p: TimelinePoint; cx: number; cy: number; fresh: boolean }) {
  const cls = `marker${fresh ? ' pop' : ''}${p.over ? ' over' : ''}`;
  const title = <title>{p.label}</title>;
  if (p.kind === 'duplicate') return <circle cx={cx} cy={cy} r={7} className={`${cls} hollow`}>{title}</circle>;
  if (p.kind === 'late') return <circle cx={cx} cy={cy} r={4} className={`${cls} hollow`}>{title}</circle>;
  if (p.kind === 'deal') return <rect x={cx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${cx} ${cy})`} className={`${cls} hollow`}>{title}</rect>;
  return (
    <g className={cls}>
      {p.kind === 'amend' && <circle cx={cx} cy={cy} r={11} className="ring" />}
      <circle cx={cx} cy={cy} r={6} className="dot">{title}</circle>
    </g>
  );
}

/** One office's Qdrant point: what the payload holds, and what each of the three vectors was built from. */
function PointView({ card, color, status }: { card: OfficeCard; color: string; status: SummaryStatus }) {
  const anatomy = pointAnatomy(card);
  const over = card.lines.filter((l) => l.status === 'over');
  return (
    <div className="point-view" style={{ '--office': color } as CSSProperties}>
      <header className="point-head">
        <span className="point-name">{card.name}</span>
        <span className="mono point-id">point {anatomy.shortId}… · shard {anatomy.shard}</span>
      </header>
      <div className="point-cols">
        <section aria-label="Payload">
          <h3>Payload</h3>
          <ol className="payload">
            {anatomy.rows.slice(0, 7).map((row) => (
              <li key={row.id} data-status={row.status}>
                <span className="mono">{row.label}</span><span className="num">{row.amount}</span><span className="status">{row.status}</span>
              </li>
            ))}
            {anatomy.rows.length > 7 && <li className="more">+ {anatomy.rows.length - 7} older</li>}
            {anatomy.rows.length === 0 && <li className="more">no documents yet</li>}
          </ol>
          {over.map((l) => <p key={l.category} className="point-over"><CircleAlert size={15} aria-hidden="true" /> {l.name} over by {euro(l.over_by)}</p>)}
        </section>
        <section aria-label="Vectors">
          <h3>Vectors</h3>
          <dl className="vectors">
            <dt><b>summary</b> · dense, 384 · <span className="summary-status" data-state={status.state}>{status.label}</span></dt>
            <dd className="quote">{card.summary_text ? `“${card.summary_text}”` : 'no summary yet'}</dd>
            <dt><b>digest</b> · ColBERT, one vector per token</dt>
            <dd className="mono">{anatomy.digest.slice(0, 2).map((line) => <span key={line}>{line}</span>)}{anatomy.digest.length > 2 && <span>+ {anatomy.digest.length - 2} lines</span>}{!anatomy.digest.length && 'no lines yet'}</dd>
            <dt><b>bm25</b> · sparse</dt>
            <dd>German text of {anatomy.bm25Documents} {anatomy.bm25Documents === 1 ? 'PDF' : 'PDFs'}, word for word</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

type BoxProps = { card: OfficeCard; color: string; flash?: SeenEvent; status: SummaryStatus; lens?: LensKey; selected: boolean; onOpen: () => void };

function OfficeBox({ card, color, flash, status, lens, selected, onOpen }: BoxProps) {
  const key = flash ? `${flash.kind}-${flash.document_id ?? ''}-${flash.seenAt}` : null;
  const over = card.lines.filter((l) => l.status === 'over');
  return (
    <button type="button" id={`card-${card.office_id}`} className="box" data-flash={flash?.kind} data-lens={lens} data-selected={selected || undefined}
      style={{ '--office': color, ...(lens ? { '--lens-color': LENS_COLOR[lens] } : {}) } as CSSProperties}
      onClick={onOpen} aria-label={`${card.name}: open its point`}>
      {key && <span key={key} className="flash-ring" aria-hidden="true" />}
      {flash?.kind === 'duplicate' && <span key={key} className="stamp dup-stamp" aria-hidden="true">Seen before</span>}
      <span className="box-head">
        <span className="box-name">{card.name}</span>
        <span className="box-pct num">{card.used_pct.toFixed(1)}%</span>
        <span className="box-total num">{compactEuro(card.committed)}</span>
        {over.length > 0 && <span className="chip" data-tone="error"><CircleAlert size={13} aria-hidden="true" /> over plan</span>}
      </span>
      <span className="summary-wrap" data-state={status.state}>
        <span className="summary" data-fresh={status.state === 'current'}>
          <Typewriter text={card.summary_text || 'No documents yet.'} play={flash?.kind === 'summary' ? key : null} />
        </span>
      </span>
      <SummaryLine status={status} />
    </button>
  );
}

/** Where the cached summary stands; while updating, the old one is still the one served. */
export function SummaryLine({ status }: { status: SummaryStatus }) {
  const Icon = status.state === 'updating' ? LoaderCircle : status.state === 'stale' ? TriangleAlert : Sparkles;
  return (
    <span className="summary-status" data-state={status.state}>
      <Icon size={14} className={status.state === 'updating' ? 'spin' : undefined} aria-hidden="true" /> {status.label}
    </span>
  );
}

const last = <T,>(xs: T[]): T => xs[xs.length - 1];

function niceMax(v: number): number {
  const step = v <= 10 ? 2 : v <= 25 ? 5 : v <= 50 ? 10 : 25;
  return Math.ceil(v / step) * step;
}

/** End labels sorted by height and pushed at least 22 px apart so names never overlap. */
function placeLabels(items: { key: string; y: number }[], h: number): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) sorted[i].y = Math.max(sorted[i].y, sorted[i - 1].y + 22);
  const overflow = sorted.length ? sorted[sorted.length - 1].y - (h - PAD.bottom - 4) : 0;
  return Object.fromEntries(sorted.map((s) => [s.key, s.y - Math.max(0, overflow)]));
}

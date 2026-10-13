'use client';
// The latest document, quiet: where it came from, the paper, its amount, and one progress line through n8n's
// stages with observed timings. A failed read, a document being read, or a fresh duplicate or amendment takes over.
import { BOOTH_POOL } from '@/lib/pool';
import { euro } from '@/lib/format';
import type { DocumentEntry, OfficeCard } from '@/lib/shape';
import type { Spotlight as Spot } from '@/lib/spotlight';
import { summaryStatus } from '@/lib/summary';
import { CountUp } from './motion';

export type StageTimes = Record<string, { received?: number; rough?: number; sharp?: number; summary?: number }>;
export type Correction = { from: number | null; to: number | null };

type Props = { spot: Spot; times: StageTimes; corrections: Record<string, Correction>; now: number };

const HEADLINE = { error: 'Read failed', running: 'Reading now', attention: 'Needs attention', latest: 'Latest document', idle: 'Waiting for the first document' };

export function Spotlight({ spot, times, corrections, now }: Props) {
  if (spot.kind === 'idle') {
    return (
      <section className="panel spotlight" data-kind="idle" aria-label="Latest document">
        <p className="eyebrow">{HEADLINE.idle}</p>
        <p className="spot-idle">Start the working day on the Console, or send a document from the Form.</p>
      </section>
    );
  }
  const { office, document: doc } = spot;
  const current = spot.kind === 'attention' && spot.reason === 'superseded'
    ? office.documents.find((d) => d.doc_key === doc.doc_key && d.status === 'current') : undefined;
  const original = spot.kind === 'attention' && spot.reason === 'duplicate'
    ? office.documents.find((d) => d.document_id === doc.duplicate_of) : undefined;
  const shown = current ?? original ?? doc;
  const correction = corrections[shown.document_id];
  const headline = spot.kind === 'attention' ? (spot.reason === 'duplicate' ? 'Duplicate, not summed' : 'Amended, old version kept') : HEADLINE[spot.kind];
  return (
    <section className="panel spotlight" data-kind={spot.kind} aria-live="polite" aria-label="Latest document">
      {spot.kind === 'attention' && spot.reason === 'duplicate' && <span key={doc.document_id} className="stamp" aria-hidden="true">Seen before</span>}
      <p className="eyebrow">{headline} · {source(shown)}</p>
      <div className="spot-body">
        <Paper doc={shown} office={office} reading={spot.kind === 'running'} />
        <div className="spot-facts">
          <span className="spot-key"><span className="mono">{shown.doc_key ?? shown.filename ?? 'new document'}</span>
            <small>{office.name}{shown.version ? ` · v${shown.version}` : ''}</small></span>
          <Amount doc={shown} old={current ? doc : undefined} correction={correction} failed={spot.kind === 'error'} />
          {spot.kind === 'error' && <span className="spot-error">{doc.error || 'unknown error'}</span>}
        </div>
      </div>
      {doc.kind !== 'duplicate' && <Progress doc={shown} office={office} times={times[shown.document_id] ?? {}} failed={spot.kind === 'error'} now={now} />}
    </section>
  );
}

/** The honest line, where it matters: who produced this document. */
function source(doc: DocumentEntry): string {
  return BOOTH_POOL.some((d) => d.file === doc.filename?.replace(/-copy\.pdf$/, '.pdf')) ? 'a booth document' : 'written by an AI worker';
}

function Amount({ doc, old, correction, failed }: { doc: DocumentEntry; old?: DocumentEntry; correction?: Correction; failed: boolean }) {
  if (doc.stage === 0 && doc.kind === 'document') return <span className="hero-amount rough num" aria-label="amount not read yet">… €</span>;
  if (doc.stage === 1) return <span className="hero-amount rough num" title="rough read: German amounts are misread on purpose">{euro(doc.amount)}</span>;
  if (failed) return <span className="hero-amount num">{euro(doc.amount)}</span>;
  const wasAmended = !!old;
  const was = old ? old.amount : correction && correction.from !== correction.to ? correction.from : null;
  const wasTitle = wasAmended
    ? 'the earlier version of this document, now superseded'
    : 'rough read: German amounts are misread on purpose; the vision model corrected this one';
  return (
    <span className="amount-line">
      {was !== null && was !== undefined && <span className="was num" title={wasTitle}>{euro(was)}</span>}
      <span className="hero-amount num"><CountUp value={doc.amount ?? 0} format={euro} /></span>
    </span>
  );
}

const TITLES = { cost: 'BESTELLUNG', deal: 'KUNDENAUFTRAG', credit: 'GUTSCHRIFT' } as const;
const deMoney = (n: number | null) => (n === null ? '…' : `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);

function Paper({ doc, office, reading }: { doc: DocumentEntry; office: OfficeCard; reading: boolean }) {
  return (
    <div className="paper" key={doc.document_id} aria-hidden="true">
      {reading && <span className="scan" />}
      <h4>Q8nten GmbH</h4>
      <strong>{doc.doc_type ? TITLES[doc.doc_type] : 'BELEG'}</strong>
      <div className="rule" />
      <div className="row"><span>Belegnummer</span><span>{doc.doc_key ?? '…'}</span></div>
      <div className="row"><span>Standort</span><span>{office.name}</span></div>
      <div className="row"><span>{doc.doc_type === 'deal' ? 'Kunde' : 'Lieferant'}</span><span>{(doc.counterparty ?? '…').slice(0, 18)}</span></div>
      <div className="amount-row"><span>Betrag</span><span>{deMoney(doc.amount)}</span></div>
    </div>
  );
}

/** One line through n8n's four stages; each dot lights when the poll sees the stage, with its time since arrival.
 * The last step tells where the office's cached summary stands: rewritten, being rewritten, or out of date. */
function Progress({ doc, office, times, failed, now }: { doc: DocumentEntry; office: OfficeCard; times: StageTimes[string]; failed: boolean; now: number }) {
  const summary = summaryStatus(office, now);
  const t0 = times.received;
  const after = (t?: number) => (t !== undefined && t0 !== undefined ? `+${Math.max(0, Math.round((t - t0) / 1000))} s` : '');
  const sharp = doc.stage === 2;
  const summaryState = !sharp ? 'waiting' : summary.state === 'current' ? 'done' : summary.state === 'updating' ? 'active' : 'stale';
  const summaryWho = !sharp ? 'after every read' : summary.state === 'current' ? `cached in Qdrant${after(times.summary) ? ` · ${after(times.summary)}` : ''}` : summary.label;
  const steps = [
    { name: 'Received', who: `n8n${t0 !== undefined ? ' · 0 s' : ''}`, state: 'done' },
    { name: 'Rough read', who: `n8n regex${after(times.rough) ? ` · ${after(times.rough)}` : ''}`, state: doc.stage >= 1 || doc.stage === -1 ? 'done' : doc.stage === 0 ? 'active' : 'waiting' },
    { name: 'Vision read', who: `n8n + model${after(times.sharp) ? ` · ${after(times.sharp)}` : ''}`, state: failed ? 'failed' : sharp ? 'done' : doc.stage === 1 ? 'active' : 'waiting' },
    { name: 'Summary', who: summaryWho, state: summaryState },
  ];
  return (
    <ol className="progress" aria-label="Stages">
      {steps.map((s) => (
        <li key={s.name} data-state={s.state}>
          <span className="dot" aria-hidden="true" />
          <span className="step-name">{s.name}</span>
          <span className="step-who">{s.who}</span>
        </li>
      ))}
    </ol>
  );
}

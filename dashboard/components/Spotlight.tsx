'use client';
import { CircleAlert, FileText, Radio, ScanLine, TriangleAlert } from 'lucide-react';
import { euro } from '@/lib/format';
import type { DocumentEntry, OfficeCard } from '@/lib/shape';
import type { Spotlight as Spot } from '@/lib/spotlight';
import { CountUp } from './motion';

export type StageTimes = Record<string, { received?: number; rough?: number; sharp?: number; summary?: number }>;
export type Correction = { from: number | null; to: number | null };

type Props = { spot: Spot; times: StageTimes; corrections: Record<string, Correction>; tookMs: number | null };

const LABEL = {
  error: { Icon: CircleAlert, text: 'Needs attention · read failed' },
  running: { Icon: ScanLine, text: 'Reading now' },
  attention: { Icon: TriangleAlert, text: 'Needs attention' },
  latest: { Icon: FileText, text: 'Latest document' },
  idle: { Icon: Radio, text: 'Waiting for the first document' },
} as const;

/** The first tile: whatever needs eyes now, with the document, its stages, and what reading it cost. */
export function Spotlight({ spot, times, corrections, tookMs }: Props) {
  const { Icon, text } = LABEL[spot.kind];
  return (
    <section className="panel spotlight" data-kind={spot.kind} aria-live="polite" aria-label="Spotlight">
      <h2 className="spot-label" data-kind={spot.kind}>
        <Icon size={20} aria-hidden="true" />
        {spot.kind === 'attention' ? `${text} · ${spot.reason === 'duplicate' ? 'duplicate' : 'amended'}` : text}
        {spot.kind === 'latest' && spot.overPlan && <span className="chip" data-tone="error">{spot.office.name} over plan</span>}
      </h2>
      {spot.kind === 'idle' ? <Idle /> : <Body spot={spot} times={times} corrections={corrections} />}
      {spot.kind !== 'idle' && (
        <p className="cost-line">
          <span>Read once: <b>1 vision + 1 summary call</b></span>
          <span>Every answer after: <b>0 model calls</b>{tookMs !== null && <>, <b className="num">{tookMs} ms</b></>}</span>
        </p>
      )}
      <p className="caption">n8n reads twice: a quick rough read, then a vision read that corrects it.</p>
    </section>
  );
}

function Idle() {
  return (
    <div className="spot-facts">
      <span className="spot-key">No documents yet</span>
      <span className="spot-what">Start the working day on the Console, or scan the Form QR code and send one.</span>
    </div>
  );
}

function Body({ spot, times, corrections }: { spot: Exclude<Spot, { kind: 'idle' }>; times: StageTimes; corrections: Record<string, Correction> }) {
  const { office, document: doc } = spot;
  const current = spot.kind === 'attention' && spot.reason === 'superseded'
    ? office.documents.find((d) => d.doc_key === doc.doc_key && d.status === 'current') : undefined;
  const shown = current ?? doc;
  const correction = corrections[shown.document_id];
  const original = spot.kind === 'attention' && spot.reason === 'duplicate'
    ? office.documents.find((d) => d.document_id === doc.duplicate_of) : undefined;
  return (
    <>
      {spot.kind === 'attention' && spot.reason === 'duplicate' && <span key={doc.document_id} className="stamp" aria-hidden="true">Seen before</span>}
      <div className="spot-body">
        <Paper doc={original ?? shown} office={office} reading={spot.kind === 'running'} />
        <div className="spot-facts">
          <span className="spot-key mono">{(original ?? shown).doc_key ?? (shown.filename ?? 'new document')}
            <small>{office.name}{(original ?? shown).version ? ` · v${(original ?? shown).version}` : ''}</small></span>
          <Amount spot={spot} doc={original ?? shown} old={current ? doc : undefined} correction={correction} />
          <span className="spot-what">{explain(spot, original, current)}</span>
        </div>
      </div>
      <Stages doc={shown} office={office} times={times[shown.document_id] ?? {}} failed={spot.kind === 'error'} />
    </>
  );
}

function Amount({ spot, doc, old, correction }: { spot: Exclude<Spot, { kind: 'idle' }>; doc: DocumentEntry; old?: DocumentEntry; correction?: Correction }) {
  if (doc.stage === 0 && doc.kind === 'document') return <span className="hero-amount rough num" aria-label="amount not read yet">… €</span>;
  if (doc.stage === 1) return <span className="hero-amount rough num" title="rough read">{euro(doc.amount)}</span>;
  if (spot.kind === 'error') return <span className="hero-amount num">{euro(doc.amount)}</span>;
  return (
    <span>
      {old && <span className="was num">{euro(old.amount)}</span>}
      {!old && correction && correction.from !== null && correction.from !== correction.to && <span className="was num">{euro(correction.from)}</span>}
      <span className="hero-amount num"><CountUp value={doc.amount ?? 0} format={euro} /></span>
    </span>
  );
}

function explain(spot: Exclude<Spot, { kind: 'idle' }>, original?: DocumentEntry, current?: DocumentEntry): string {
  const doc = spot.document;
  if (spot.kind === 'error') return `The vision read failed: ${doc.error || 'unknown error'}. The rough fields stay; the office keeps going.`;
  if (spot.kind === 'running') return doc.stage === 0 ? 'Received. n8n stored it with its PDF and started the reads.'
    : 'Rough read done: German amounts are misread on purpose (12.300,00 € reads as 12.3). The vision read fixes it.';
  if (spot.kind === 'attention' && spot.reason === 'duplicate') return `Same bytes as ${original?.filename ?? 'an earlier file'}: recorded and counted once, never summed.`;
  if (spot.kind === 'attention') return `Version ${current?.version ?? '?'} replaces version ${doc.version ?? '?'}. The old one is kept for history, never summed.`;
  return [doc.counterparty, doc.description_en].filter(Boolean).join(' · ');
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
      <div className="row"><span>Version</span><span>{doc.version ?? '…'}</span></div>
      <div className="row"><span>Standort</span><span>{office.name}</span></div>
      <div className="row"><span>{doc.doc_type === 'deal' ? 'Kunde' : 'Lieferant'}</span><span>{(doc.counterparty ?? '…').slice(0, 18)}</span></div>
      <div className="amount-row"><span>Betrag</span><span>{deMoney(doc.amount)}</span></div>
    </div>
  );
}

function Stages({ doc, office, times, failed }: { doc: DocumentEntry; office: OfficeCard; times: StageTimes[string]; failed: boolean }) {
  const summarized = doc.stage === 2 && office.pending_count === 0 && office.summary_stage === 3;
  const t0 = times.received;
  const after = (t?: number) => (t !== undefined && t0 !== undefined ? `+${Math.max(0, Math.round((t - t0) / 1000))} s` : '');
  const state = (done: boolean, active: boolean) => (done ? 'done' : active ? 'active' : 'waiting');
  const steps = [
    { n: '01', name: 'Received', who: 'n8n', s: 'done', t: t0 !== undefined ? '0 s' : '' },
    { n: '02', name: 'Rough read', who: 'n8n regex', s: failed && doc.stage < 1 ? 'failed' : state(doc.stage >= 1 || doc.stage === -1, doc.stage === 0), t: after(times.rough) },
    { n: '03', name: 'Vision read', who: 'n8n + model', s: failed ? 'failed' : state(doc.stage === 2, doc.stage === 1), t: after(times.sharp) },
    { n: '04', name: 'Summary', who: 'cached in Qdrant', s: state(summarized, doc.stage === 2 && !summarized && office.pending_count === 0), t: after(times.summary) },
  ];
  if (doc.kind === 'duplicate') return null;
  return (
    <ol className="stages" aria-label="Stages">
      {steps.map((step) => (
        <li key={step.n} className="stage" data-state={step.s}>
          <b>{step.n} · <span className="stage-n8n">{step.who}</span></b>
          <span>{step.name}</span>
          <span className="t num">{step.s === 'active' ? 'working…' : step.t}</span>
        </li>
      ))}
    </ol>
  );
}


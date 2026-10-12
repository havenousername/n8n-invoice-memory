'use client';
// The aisle screen. The poller reads the manager's shard every 2 s; diffOffices turns two reads into events, and
// every animation starts from one of those events. Nothing here calls n8n.
import { useCallback, useEffect, useRef, useState } from 'react';
import { diffOffices } from '@/lib/events';
import type { ManagerId } from '@/lib/offices';
import { createPoller } from '@/lib/poll';
import type { OfficeCard as Card } from '@/lib/shape';
import { pickSpotlight, type SeenEvent } from '@/lib/spotlight';
import { AskPanel, type Answer } from './AskPanel';
import { Beams } from './Beams';
import { OfficesPanel, type OfficeView } from './OfficesPanel';
import { topHits, type LensKey } from './LensColumns';
import { PasscodeGate } from './PasscodeGate';
import { ShardSwap } from './ShardSwap';
import { Stage } from './Stage';
import { Spotlight, type Correction, type StageTimes } from './Spotlight';

type Offices = { offices: Card[]; took_ms: number } | { locked: true };
const ORDER = ['berlin', 'munich', 'vienna', 'amsterdam', 'paris', 'london'];
const FLASH_MS = 4500;
const RING_MS = 9000;
const LENS_FLIP_MS = 3500;
const AUTO_POINT_MS = 7000;
const AUTO_POINT = new Set<SeenEvent['kind']>(['corrected', 'superseded', 'duplicate']);
const SWAP_MS = 5000;
const PRIORITY: Record<SeenEvent['kind'], number> = { error: 7, duplicate: 6, superseded: 5, corrected: 4, summary: 3, received: 2, stage: 1 };

export function ManagerView({ initialManager }: { initialManager: ManagerId }) {
  const [manager, setManager] = useState<ManagerId>(initialManager);
  const [swap, setSwap] = useState<{ from: ManagerId; at: number } | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [locked, setLocked] = useState(false);
  const [tape, setTape] = useState<SeenEvent[]>([]);
  const [flashes, setFlashes] = useState<Record<string, SeenEvent>>({});
  const [times, setTimes] = useState<StageTimes>({});
  const [corrections, setCorrections] = useState<Record<string, Correction>>({});
  const [answer, setAnswer] = useState<(Answer & { manager: ManagerId; at: number }) | null>(null);
  const [lens, setLens] = useState<LensKey>('summary');
  const [askOpen, setAskOpen] = useState(true);
  const [view, setView] = useState<OfficeView & { until?: number }>({ mode: 'chart' });
  const [now, setNow] = useState(0); // set by the poll and a 1 s tick; never read during render on the server
  const previous = useRef<Card[] | null>(null);
  const managerRef = useRef<ManagerId>(initialManager);
  const poller = useRef<ReturnType<typeof createPoller<Offices>> | null>(null);
  const flip = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onData = useCallback((key: string, data: Offices) => {
    if ('locked' in data) { setLocked(true); return; }
    const t = Date.now();
    setNow(t);
    const events: SeenEvent[] = diffOffices(previous.current, data.offices).map((e) => ({ ...e, seenAt: t }));
    if (previous.current === null) setTape(seedTape(data.offices));
    else if (events.length) setTape((old) => [...[...events].reverse(), ...old].slice(0, 40));
    if (events.length) {
      setFlashes((old) => {
        const next = { ...old };
        for (const e of events) if (!next[e.office_id] || next[e.office_id].seenAt !== t || PRIORITY[e.kind] > PRIORITY[next[e.office_id].kind]) next[e.office_id] = e;
        return next;
      });
      setTimes((old) => recordTimes(old, events, data.offices, t));
      setCorrections((old) => {
        const next = { ...old };
        for (const e of events) if (e.kind === 'corrected' && e.document_id) next[e.document_id] = { from: e.from ?? null, to: e.to ?? null };
        return next;
      });
      // A notable change opens that office's point for a few seconds, unless someone pinned a point by clicking.
      const notable = [...events].reverse().find((e) => AUTO_POINT.has(e.kind));
      if (notable) setView((v) => (v.mode === 'point' && v.pinned ? v : { mode: 'point', office: notable.office_id, pinned: false, until: t + AUTO_POINT_MS }));
    }
    previous.current = data.offices;
    setCards([...data.offices].sort((a, b) => ORDER.indexOf(a.office_id) - ORDER.indexOf(b.office_id)));
    setTookMs(data.took_ms);
    setOffline(false);
    void key;
  }, []);

  useEffect(() => {
    const p = createPoller<Offices>({
      intervalMs: 2000,
      fetchOnce: async (key) => {
        const response = await fetch(`/api/offices?manager=${key}`, { cache: 'no-store' });
        if (response.status === 401) return { locked: true };
        if (!response.ok) throw new Error(`offices ${response.status}`);
        return response.json();
      },
      onData: (key, data) => { if ('locked' in data) p.stop(); onData(key, data); },
      onError: (_failures, isOffline) => setOffline(isOffline),
    });
    poller.current = p;
    p.start(managerRef.current);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { p.stop(); clearInterval(tick); if (flip.current) clearTimeout(flip.current); };
  }, [onData]);

  function switchTo(next: ManagerId) {
    if (next === managerRef.current) return;
    setSwap({ from: managerRef.current, at: Date.now() });
    managerRef.current = next;
    setManager(next);
    previous.current = null;
    setCards(null); setFlashes({}); setAnswer(null); setView({ mode: 'chart' });
    poller.current?.setKey(next);
    window.history.replaceState(null, '', `?manager=${next}`);
  }

  function unlock() {
    setLocked(false);
    previous.current = null;
    poller.current?.start(managerRef.current);
  }

  const onAnswer = useCallback((a: Answer | null) => {
    setAnswer(a ? { ...a, manager: managerRef.current, at: Date.now() } : null);
    // Show what the summary answers, then flip once to what the PDF answers, so the aisle sees both.
    setLens('summary');
    if (flip.current) clearTimeout(flip.current);
    if (a) flip.current = setTimeout(() => setLens('pdf'), LENS_FLIP_MS);
  }, []);

  if (locked) return <PasscodeGate onUnlocked={unlock} />;

  const shown = cards ?? [];
  const spot = pickSpotlight(shown, tape, now);
  const liveAnswer = answer && answer.manager === manager ? answer : null;
  const ringsOn = liveAnswer && now - liveAnswer.at < RING_MS;
  const lensOf = (office: string): LensKey | undefined =>
    ringsOn && topHits(liveAnswer.lenses)[lens]?.office_id === office ? lens : undefined;
  const freshFlash = (office: string) => {
    const f = flashes[office];
    return f && now - f.seenAt < FLASH_MS ? f : undefined;
  };
  const officeView: OfficeView = view.mode === 'point' && !view.pinned && view.until !== undefined && now > view.until ? { mode: 'chart' } : view;
  const slots = Array.from({ length: 3 }, (_, i) => shown[i] ?? null);

  return (
    <>
    <Stage>
    <div className="shell">
      <header className="header">
        <span className="brand-name">Q8nten</span>
        <span className="brand-sub">documents by <b className="n8n">n8n</b> · memory in <b className="qdrant">Qdrant</b></span>
        <span className="header-spacer" />
        <ShardSwap manager={manager} swappedFrom={swap && now - swap.at < SWAP_MS ? swap.from : null} onSwitch={switchTo} />
        <span className={`live${offline ? ' offline' : ''}`} role="status">
          <span className="live-dot" aria-hidden="true" />
          {offline ? 'offline, last known offices' : tookMs !== null ? <>live · <span className="num">{tookMs} ms</span></> : 'connecting…'}
        </span>
      </header>

      <main className={`split${askOpen ? '' : ' ask-closed'}`}>
        <div className="left">
          {cards ? <Spotlight spot={spot} times={times} corrections={corrections} /> : <div className="skeleton spot-skeleton" aria-hidden="true" />}
          <OfficesPanel cards={slots} now={now} view={officeView} onView={setView} flashFor={freshFlash} lensFor={lensOf} />
        </div>
        <AskPanel manager={manager} answer={liveAnswer} onAnswer={onAnswer} lens={lens} onLens={setLens}
          open={askOpen} onToggle={() => setAskOpen((o) => !o)} />
      </main>
    </div>
    </Stage>
    {askOpen && <Beams lenses={ringsOn ? liveAnswer.lenses : null} lens={lens} stamp={liveAnswer ? `${liveAnswer.at}` : null} />}
    </>
  );
}

function seedTape(cards: Card[]): SeenEvent[] {
  return cards
    .flatMap((card) => card.documents.map((d) => ({ card, d })))
    .sort((a, b) => b.d.received_at.localeCompare(a.d.received_at))
    .slice(0, 10)
    .map(({ card, d }) => ({
      kind: d.kind === 'duplicate' ? 'duplicate' : 'received', office_id: card.office_id, office_name: card.name, at: d.received_at,
      document_id: d.document_id, doc_key: d.doc_key, version: d.version, filename: d.filename, seenAt: Date.parse(d.received_at),
    }));
}

function recordTimes(old: StageTimes, events: SeenEvent[], cards: Card[], t: number): StageTimes {
  const next = { ...old };
  const mark = (id: string, field: keyof StageTimes[string]) => { next[id] = { ...next[id] }; next[id][field] ??= t; };
  for (const e of events) {
    if (e.kind === 'received' && e.document_id) mark(e.document_id, 'received');
    if (e.kind === 'stage' && e.document_id && e.to === 1) mark(e.document_id, 'rough');
    if (e.kind === 'stage' && e.document_id && e.to === 2) mark(e.document_id, 'sharp');
    if (e.kind === 'summary') {
      const latest = cards.find((c) => c.office_id === e.office_id)?.latest?.document_id;
      if (latest) mark(latest, 'summary');
    }
  }
  return next;
}

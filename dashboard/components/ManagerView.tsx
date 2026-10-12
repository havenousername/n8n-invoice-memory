'use client';
// The aisle screen. useOfficeFeed reads the manager's shard every 2 s and turns two reads into events; every
// animation starts from one of those events. Nothing here calls n8n.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ManagerId } from '@/lib/offices';
import { pickSpotlight, type SeenEvent } from '@/lib/spotlight';
import { AskPanel, type Answer } from './AskPanel';
import { Beams } from './Beams';
import { OfficesPanel, type OfficeView } from './OfficesPanel';
import { topHits, type LensKey } from './LensColumns';
import { PasscodeGate } from './PasscodeGate';
import { ShardSwap } from './ShardSwap';
import { Stage } from './Stage';
import { Spotlight } from './Spotlight';
import { useOfficeFeed, type Feed } from './useOfficeFeed';

const FLASH_MS = 4500;
const RING_MS = 9000;
const LENS_FLIP_MS = 3500;
const AUTO_POINT_MS = 7000;
const AUTO_POINT = new Set<SeenEvent['kind']>(['corrected', 'superseded', 'duplicate']);
const SWAP_MS = 5000;

export function ManagerView({ initialManager }: { initialManager: ManagerId }) {
  const [manager, setManager] = useState<ManagerId>(initialManager);
  const [swap, setSwap] = useState<{ from: ManagerId; at: number } | null>(null);
  const [answer, setAnswer] = useState<(Answer & { at: number }) | null>(null);
  const [lens, setLens] = useState<LensKey>('summary');
  const [askOpen, setAskOpen] = useState(true);
  const [view, setView] = useState<OfficeView & { until?: number }>({ mode: 'chart' });
  const flip = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A notable change opens that office's point for a few seconds, unless someone pinned a point by clicking.
  const onEvents = useCallback((events: SeenEvent[], t: number) => {
    const notable = [...events].reverse().find((e) => AUTO_POINT.has(e.kind));
    if (notable) setView((v) => (v.mode === 'point' && v.pinned ? v : { mode: 'point', office: notable.office_id, pinned: false, until: t + AUTO_POINT_MS }));
  }, []);
  const managers = useMemo(() => [manager], [manager]);
  const feed = useOfficeFeed(managers, onEvents);
  useEffect(() => () => { if (flip.current) clearTimeout(flip.current); }, []);

  function switchTo(next: ManagerId) {
    if (next === manager) return;
    setSwap({ from: manager, at: Date.now() });
    setManager(next);
    setAnswer(null); setView({ mode: 'chart' });
    window.history.replaceState(null, '', `?manager=${next}`);
  }

  const onAnswer = useCallback((a: Answer | null) => {
    setAnswer(a ? { ...a, at: Date.now() } : null);
    // Show what the summary answers, then flip once to what the PDF answers, so the aisle sees both.
    setLens('summary');
    if (flip.current) clearTimeout(flip.current);
    if (a) flip.current = setTimeout(() => setLens('pdf'), LENS_FLIP_MS);
  }, []);

  if (feed.locked) return <PasscodeGate onUnlocked={feed.unlock} />;

  const { now, flashes } = feed;
  const shown = feed.cards ?? [];
  const spot = pickSpotlight(shown, feed.tape, now);
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
        <Live feed={feed} />
      </header>

      <main className={`split${askOpen ? '' : ' ask-closed'}`}>
        <div className="left">
          {feed.cards ? <Spotlight spot={spot} times={feed.times} corrections={feed.corrections} now={now} /> : <div className="skeleton spot-skeleton" aria-hidden="true" />}
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

export function Live({ feed }: { feed: Feed }) {
  return (
    <span className={`live${feed.offline ? ' offline' : ''}`} role="status">
      <span className="live-dot" aria-hidden="true" />
      {feed.offline ? 'offline, last known offices' : feed.tookMs !== null ? <>live · <span className="num">{feed.tookMs} ms</span></> : 'connecting…'}
    </span>
  );
}

'use client';
// The live feed both screens share: poll the shards every 2 s, turn two reads into events (diffOffices), and keep
// what the animations need: recent events, the newest event per office, stage timings, and corrections.
import { useCallback, useEffect, useRef, useState } from 'react';
import { diffOffices } from '@/lib/events';
import type { ManagerId } from '@/lib/offices';
import { createPoller } from '@/lib/poll';
import type { OfficeCard as Card } from '@/lib/shape';
import type { SeenEvent } from '@/lib/spotlight';
import type { Correction, StageTimes } from './Spotlight';

type Read = { offices: Card[]; took_ms: number } | { locked: true };
const ORDER = ['berlin', 'munich', 'vienna', 'amsterdam', 'paris', 'london'];
const PRIORITY: Record<SeenEvent['kind'], number> = { error: 7, duplicate: 6, superseded: 5, corrected: 4, summary: 3, received: 2, stage: 1 };

export type Feed = {
  cards: Card[] | null; tape: SeenEvent[]; flashes: Record<string, SeenEvent>; times: StageTimes;
  corrections: Record<string, Correction>; tookMs: number | null; offline: boolean; locked: boolean; now: number;
  unlock: () => void;
};

/** `managers` is the set of shards to read: one on the aisle screen, both on the Console. */
export function useOfficeFeed(managers: ManagerId[], onEvents?: (events: SeenEvent[], t: number) => void): Feed {
  const key = managers.join(',');
  const [read, setRead] = useState<{ key: string; cards: Card[] } | null>(null);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [locked, setLocked] = useState(false);
  const [tape, setTape] = useState<SeenEvent[]>([]);
  const [flashes, setFlashes] = useState<Record<string, SeenEvent>>({});
  const [times, setTimes] = useState<StageTimes>({});
  const [corrections, setCorrections] = useState<Record<string, Correction>>({});
  const [now, setNow] = useState(0); // set by the poll and a 1 s tick; never read during render on the server
  const previous = useRef<Card[] | null>(null);
  const keyRef = useRef(key);
  const poller = useRef<ReturnType<typeof createPoller<Read>> | null>(null);
  const listener = useRef(onEvents);
  useEffect(() => { listener.current = onEvents; }, [onEvents]);

  const onData = useCallback((readKey: string, data: Read) => {
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
      listener.current?.(events, t);
    }
    previous.current = data.offices;
    setRead({ key: readKey, cards: [...data.offices].sort((a, b) => ORDER.indexOf(a.office_id) - ORDER.indexOf(b.office_id)) });
    setTookMs(data.took_ms);
    setOffline(false);
  }, []);

  useEffect(() => {
    const p = createPoller<Read>({
      intervalMs: 2000,
      fetchOnce: async (shards) => {
        const reads = await Promise.all(shards.split(',').map(async (manager) => {
          const response = await fetch(`/api/offices?manager=${manager}`, { cache: 'no-store' });
          if (response.status === 401) return 'locked' as const;
          if (!response.ok) throw new Error(`offices ${response.status}`);
          return (await response.json()) as { offices: Card[]; took_ms: number };
        }));
        if (reads.includes('locked')) return { locked: true };
        const ok = reads as { offices: Card[]; took_ms: number }[];
        return { offices: ok.flatMap((r) => r.offices), took_ms: Math.max(...ok.map((r) => r.took_ms)) };
      },
      onData: (k, data) => { if ('locked' in data) p.stop(); onData(k, data); },
      onError: (_failures, isOffline) => setOffline(isOffline),
    });
    poller.current = p;
    p.start(keyRef.current);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { p.stop(); clearInterval(tick); };
  }, [onData]);

  // A different set of shards starts over: no events are raised by the switch itself.
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    previous.current = null;
    poller.current?.setKey(key);
  }, [key]);

  const unlock = useCallback(() => {
    setLocked(false);
    previous.current = null;
    poller.current?.start(keyRef.current);
  }, []);

  // Cards read for another set of shards are not shown while the new read is on its way.
  return { cards: read && read.key === key ? read.cards : null, tape, flashes, times, corrections, tookMs, offline, locked, now, unlock };
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

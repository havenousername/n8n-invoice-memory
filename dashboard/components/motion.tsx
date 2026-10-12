'use client';
// Shared motion: every helper becomes an instant state change under reduced motion or in a hidden tab.
import { useEffect, useState, useSyncExternalStore } from 'react';

const query = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

const still = () => typeof document !== 'undefined' && document.hidden;

/** A number that counts from its previous value to the new one. */
export function CountUp({ value, format, ms = 700 }: { value: number; format: (n: number) => string; ms?: number }) {
  const reduced = useReducedMotion();
  const [track, setTrack] = useState({ value, from: value });
  const [frameValue, setFrameValue] = useState<number | null>(null);
  if (track.value !== value) setTrack({ value, from: frameValue ?? track.value });
  useEffect(() => {
    if (track.from === track.value) return;
    const settle = () => { setFrameValue(null); setTrack({ value: track.value, from: track.value }); };
    if (reduced || still()) {
      const id = setTimeout(settle);
      return () => clearTimeout(id);
    }
    let frame = 0;
    const began = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - began) / ms);
      setFrameValue(track.from + (track.value - track.from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) frame = requestAnimationFrame(step);
      else settle();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [track, ms, reduced]);
  const shown = reduced ? value : frameValue ?? track.from;
  return <>{format(Math.round(shown * 100) / 100)}</>;
}

/** Text that writes itself when `play` changes; the full text is always in the accessibility tree. */
export function Typewriter({ text, play }: { text: string; play: string | null }) {
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState<{ play: string | null; count: number }>({ play: null, count: 0 });
  useEffect(() => {
    if (!play || reduced) return;
    const total = text.length;
    if (still()) {
      const id = setTimeout(() => setProgress({ play, count: total }));
      return () => clearTimeout(id);
    }
    const per = Math.max(8, Math.min(28, 1500 / Math.max(1, total)));
    let count = 0;
    const id = setInterval(() => {
      count = Math.min(total, count + 2);
      setProgress({ play, count });
      if (count >= total) clearInterval(id);
    }, per);
    return () => clearInterval(id);
  }, [play, text, reduced]);
  const count = play && !reduced ? (progress.play === play ? progress.count : 0) : text.length;
  return (
    <>
      <span aria-hidden="true">{text.slice(0, count)}</span>
      <span className="sr-only">{text}</span>
    </>
  );
}

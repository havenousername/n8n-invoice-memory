'use client';
import { useEffect, useState } from 'react';
import type { LensResults } from '@/lib/shape';
import { LENSES, topHits, type LensKey } from './LensColumns';
import { useReducedMotion } from './motion';

type Beam = { d: string; color: string; key: string };

/** A beam from the active lens's answer to the office it named. Purely visual; the readout carries the answer. */
export function Beams({ lenses, lens, stamp }: { lenses: LensResults | null; lens: LensKey; stamp: string | null }) {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState<{ key: string; beam: Beam } | null>(null);
  const key = stamp ? `${stamp}-${lens}` : null;
  useEffect(() => {
    if (!lenses || !key || reduced) return;
    // Measured in a frame callback: the readout and the office box must be laid out first.
    const frame = requestAnimationFrame(() => {
      const top = topHits(lenses)[lens];
      const from = document.getElementById(`lens-${lens}`)?.getBoundingClientRect();
      const to = top && document.getElementById(`card-${top.office_id}`)?.getBoundingClientRect();
      if (!from || !to) return;
      const x1 = from.left + 6, y1 = from.top + 40;
      const x2 = to.right - 10, y2 = to.top + to.height / 2;
      const bend = Math.max(60, (x1 - x2) / 2);
      setDrawn({ key, beam: { d: `M ${x1} ${y1} C ${x1 - bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`, color: LENSES.find((l) => l.key === lens)!.hex, key } });
    });
    const clear = setTimeout(() => setDrawn(null), 3200);
    return () => { cancelAnimationFrame(frame); clearTimeout(clear); };
  }, [lenses, lens, key, reduced]);
  if (!drawn || drawn.key !== key || !lenses || reduced) return null;
  return (
    <svg className="beams" aria-hidden="true">
      <path key={drawn.beam.key} d={drawn.beam.d} stroke={drawn.beam.color} style={{ color: drawn.beam.color }} />
    </svg>
  );
}

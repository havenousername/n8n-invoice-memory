'use client';
import { useEffect, useState } from 'react';
import type { LensResults } from '@/lib/shape';
import { LENSES } from './LensColumns';
import { useReducedMotion } from './motion';

const COLOR = { keyword: '#039be5', line: '#7c66ff', meaning: '#43a047' };
type Beam = { d: string; color: string; delay: number; key: string };

/** Light beams from each lens column to the office it ranked first. Purely visual; the lists carry the answer. */
export function Beams({ lenses, stamp }: { lenses: LensResults | null; stamp: string | null }) {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState<{ stamp: string; beams: Beam[] } | null>(null);
  useEffect(() => {
    if (!lenses || !stamp || reduced) return;
    // Measured after layout, in a frame callback: the cards and lens columns must be on screen first.
    const frame = requestAnimationFrame(() => {
      const next: Beam[] = [];
      LENSES.forEach((lens, i) => {
        const top = lenses[lens.key][0];
        const from = document.getElementById(`lens-${lens.key}`)?.getBoundingClientRect();
        const to = top && document.getElementById(`card-${top.office_id}`)?.getBoundingClientRect();
        if (!from || !to) return;
        const x1 = from.left + 8, y1 = from.top + 12;
        const x2 = to.right - 24, y2 = to.top + 40 + i * 18;
        const bend = Math.max(80, (x1 - x2) / 2);
        next.push({ d: `M ${x1} ${y1} C ${x1 - bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`, color: COLOR[lens.key], delay: i * 160, key: `${stamp}-${lens.key}` });
      });
      setDrawn({ stamp, beams: next });
    });
    const clear = setTimeout(() => setDrawn(null), 3400);
    return () => { cancelAnimationFrame(frame); clearTimeout(clear); };
  }, [lenses, stamp, reduced]);
  const beams = drawn && drawn.stamp === stamp && lenses && !reduced ? drawn.beams : [];
  if (!beams.length) return null;
  return (
    <svg className="beams" aria-hidden="true">
      {beams.map((b) => <path key={b.key} d={b.d} stroke={b.color} style={{ color: b.color, animationDelay: `${b.delay}ms, ${2600 + b.delay}ms` }} />)}
    </svg>
  );
}

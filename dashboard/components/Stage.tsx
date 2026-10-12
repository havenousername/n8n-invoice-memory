'use client';
// The booth screen is designed at 1920 × 1080 and scaled to whatever display runs it, so a projector, a TV, and the
// presenter's laptop show the same picture without scrolling. Narrow screens (phones) get the stacked layout instead.
import { useEffect, useState } from 'react';

export const STAGE_W = 1920;
export const STAGE_H = 1080;
const MIN_STAGE_WIDTH = 1000;

export function Stage({ children }: { children: React.ReactNode }) {
  const [scale, setScale] = useState<number | null>(null);
  useEffect(() => {
    const fit = () => setScale(innerWidth < MIN_STAGE_WIDTH ? null : Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H));
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, []);
  if (scale === null) return <>{children}</>;
  return (
    <div className="kiosk-frame" style={{ width: STAGE_W * scale, height: STAGE_H * scale }}>
      <div className="kiosk" style={{ transform: `scale(${scale})` }}>{children}</div>
    </div>
  );
}

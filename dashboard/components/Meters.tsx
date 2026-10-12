import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { euro } from '@/lib/format';
import type { RatedLine } from '@/lib/shape';

export type Flow = { category: string; text: string; kind: 'cost' | 'credit'; key: string };

const STATUS = {
  within: { Icon: CircleCheck, label: 'within plan' },
  near: { Icon: TriangleAlert, label: 'near plan' },
  over: { Icon: CircleAlert, label: 'over plan' },
} as const;

/** One meter per budget category; the fill carries severity, the track is the same hue at 20%. */
export function Meters({ lines, flow }: { lines: RatedLine[]; flow?: Flow }) {
  return (
    <div className="meters" role="list">
      {lines.map((line) => {
        const { Icon, label } = STATUS[line.status];
        return (
          <div className="meter" role="listitem" key={line.category} data-status={line.status}
            aria-label={`${line.name}: ${euro(line.committed)} of ${euro(line.budget)}, ${label}`}>
            <span className="meter-name">{line.name}</span>
            <span className="meter-track"><span className="meter-fill" style={{ transform: `scaleX(${Math.min(1, line.used)})` }} /></span>
            <span className="meter-value num">
              {line.status === 'over'
                ? <>over by {euro(line.over_by)}</>
                : <>{euro(line.committed)} <span className="of">/ {compact(line.budget)}</span></>}
              {line.status !== 'within' && <Icon size={18} aria-hidden="true" />}
            </span>
            {flow?.category === line.category && <span key={flow.key} className="flow-chip num" data-flow={flow.kind}>{flow.text}</span>}
          </div>
        );
      })}
    </div>
  );
}

const compact = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

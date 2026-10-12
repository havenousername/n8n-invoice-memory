'use client';
// What n8n is doing, drawn like its canvas: three intakes into Record, then Process (rough, vision) and the summary,
// every stage dropping into Rebuild and the office's Qdrant point. The token walks every node the document passed,
// so stages the poll saw together still play in order.
import { Bot, Database, Eye, FileInput, Inbox, MonitorPlay, RefreshCw, ScanText, Sparkles } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import type { NodeId, PipelineState } from '@/lib/pipeline';
import { useReducedMotion } from './motion';
import type { StageTimes } from './Spotlight';

const NODES: Record<NodeId, { x: number; y: number; name: string; tag: string; Icon: typeof Bot; qdrant?: boolean }> = {
  form: { x: 8, y: 18, name: 'Form', tag: '01', Icon: FileInput },
  console: { x: 8, y: 46, name: 'Console', tag: '05', Icon: MonitorPlay },
  ai: { x: 8, y: 74, name: 'AI workers', tag: '00', Icon: Bot },
  record: { x: 27, y: 46, name: 'Record', tag: '01b', Icon: Inbox },
  rough: { x: 46, y: 22, name: 'Rough read', tag: '02 · regex', Icon: ScanText },
  vision: { x: 65, y: 22, name: 'Vision read', tag: '02 · model', Icon: Eye },
  summary: { x: 86, y: 22, name: 'Summary', tag: '02b · model', Icon: Sparkles },
  rebuild: { x: 56, y: 74, name: 'Rebuild', tag: '03', Icon: RefreshCw },
  point: { x: 86, y: 74, name: 'Qdrant point', tag: 'one per office', Icon: Database, qdrant: true },
};
const EDGES: [NodeId, NodeId][] = [
  ['form', 'record'], ['console', 'record'], ['ai', 'record'], ['record', 'rough'], ['rough', 'vision'], ['vision', 'summary'],
  ['record', 'rebuild'], ['rough', 'rebuild'], ['vision', 'rebuild'], ['summary', 'rebuild'], ['rebuild', 'point'],
];
const HOP_MS = 380;

type Props = { state: PipelineState | null; docKey: string; times: StageTimes[string]; pointName: string };

export function PipelineFlow({ state, docKey, times, pointName }: Props) {
  const reduced = useReducedMotion();
  const target = state?.path ?? [];
  const [shown, setShown] = useState<{ key: string; count: number }>({ key: '', count: 0 });
  // Walk one node per hop towards the target path; a new document starts the walk over.
  useEffect(() => {
    const count = shown.key === docKey ? shown.count : 0;
    if (count >= target.length) return;
    const id = setTimeout(() => setShown({ key: docKey, count: reduced ? target.length : count + 1 }), count === 0 ? 0 : HOP_MS);
    return () => clearTimeout(id);
  }, [docKey, target.length, shown, reduced]);
  const visible = shown.key === docKey ? target.slice(0, shown.count) : [];
  const at = visible[visible.length - 1];
  const visited = new Set(visible);
  const dropsTo = visible.some((n) => n === 'record' || n === 'rough' || n === 'vision' || n === 'summary');
  const lit = (a: NodeId, b: NodeId) =>
    (visited.has(a) && visited.has(b) && visible.indexOf(b) === visible.indexOf(a) + 1) ||
    (b === 'rebuild' && visited.has(a) && dropsTo) || (a === 'rebuild' && b === 'point' && dropsTo);
  const t0 = times.received;
  const after = (t?: number) => (t !== undefined && t0 !== undefined ? `+${Math.max(0, Math.round((t - t0) / 1000))} s` : '');
  const timing: Partial<Record<NodeId, string>> = { record: t0 !== undefined ? '0 s' : '', rough: after(times.rough), vision: after(times.sharp), summary: after(times.summary) };

  return (
    <div className="flow" aria-label="The n8n pipeline">
      <svg className="flow-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {EDGES.map(([a, b]) => {
          const A = NODES[a], B = NODES[b];
          const mx = (A.x + B.x) / 2;
          return <path key={`${a}-${b}`} d={`M ${A.x} ${A.y} C ${mx} ${A.y}, ${mx} ${B.y}, ${B.x} ${B.y}`} className={lit(a, b) ? 'edge on' : 'edge'} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      {(Object.keys(NODES) as NodeId[]).map((id) => {
        const { x, y, name, tag, Icon, qdrant } = NODES[id];
        const state_ = id === at ? (state?.failed && id === state.active ? 'failed' : 'active') : visited.has(id) || (dropsTo && (id === 'rebuild' || id === 'point')) ? 'done' : 'idle';
        return (
          <div key={id} className="node" data-state={state_} data-qdrant={qdrant || undefined} style={{ left: `${x}%`, top: `${y}%` } as CSSProperties}>
            {id === 'rebuild' && dropsTo && <span key={`${docKey}-${visible.length}`} className="node-pulse" aria-hidden="true" />}
            <span className="node-tile"><Icon size={34} aria-hidden="true" /></span>
            <span className="node-name">{id === 'point' ? `${name} · ${pointName}` : name}</span>
            <span className="node-tag mono">{tag}{timing[id] ? ` · ${timing[id]}` : ''}</span>
          </div>
        );
      })}
      {at && <span className="token" style={{ left: `${NODES[at].x}%`, top: `${NODES[at].y}%` }} aria-hidden="true" />}
    </div>
  );
}

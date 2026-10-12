// Where a document is in n8n, for the Console's pipeline: which intake it came through and which nodes it has
// passed, read only from what the office point shows (its stage, kind, and the office's summary).
import { BOOTH_POOL } from './pool';
import type { DocumentEntry, OfficeCard } from './shape';

export type Intake = 'form' | 'console' | 'ai';
export type NodeId = Intake | 'record' | 'rough' | 'vision' | 'summary' | 'rebuild' | 'point';
export type PipelineState = { path: NodeId[]; active: NodeId; failed: boolean };

/** Booth files sent from this Console were remembered when sent; other booth files came through the Form. */
export function sourceOf(doc: DocumentEntry, sentFromConsole: ReadonlySet<string>): Intake {
  const file = doc.filename ?? '';
  if (!BOOTH_POOL.some((d) => d.file === file)) return 'ai';
  return sentFromConsole.has(file) ? 'console' : 'form';
}

export function pipelineState(doc: DocumentEntry, office: OfficeCard, source: Intake): PipelineState {
  const path: NodeId[] = [source, 'record'];
  if (doc.kind === 'duplicate') return { path: [...path, 'rebuild'], active: 'rebuild', failed: false };
  if (doc.stage === -1) return { path: [...path, 'rough', 'vision'], active: 'vision', failed: true };
  if (doc.stage >= 1) path.push('rough');
  if (doc.stage >= 2) path.push('vision');
  if (doc.stage === 2 && office.pending_count === 0 && office.summary_stage === 3) path.push('summary');
  return { path, active: path[path.length - 1], failed: false };
}

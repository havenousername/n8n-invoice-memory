import { CircleAlert, CircleCheck, Copy, FileInput, History, ScanLine, Sparkles } from 'lucide-react';
import { clock, euro, stageName } from '@/lib/format';
import type { SeenEvent } from '@/lib/spotlight';

const ICON = { received: FileInput, stage: ScanLine, corrected: CircleCheck, superseded: History, duplicate: Copy, summary: Sparkles, error: CircleAlert };

/** Recent events read off the office points: received, read, corrected, superseded, duplicate, summarized, failed. */
export function Tape({ events }: { events: SeenEvent[] }) {
  return (
    <section className="panel tape" aria-label="Tape">
      <h2 className="panel-title">Tape</h2>
      {events.length === 0 ? <p className="empty">Events appear here as documents move through n8n.</p> : (
        <ol aria-live="polite">
          {events.slice(0, 14).map((e) => {
            const Icon = ICON[e.kind];
            return (
              <li key={`${e.kind}-${e.document_id ?? e.office_id}-${e.seenAt}`} data-kind={e.kind}>
                <span className="when num">{clock(e.seenAt ? new Date(e.seenAt).toISOString() : e.at)}</span>
                <Icon size={18} aria-hidden="true" />
                <span className="what">{describe(e)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function describe(e: SeenEvent) {
  const key = <b className="mono">{e.doc_key ?? e.filename ?? 'document'}{e.version ? ` v${e.version}` : ''}</b>;
  switch (e.kind) {
    case 'received': return <>{key} received in {e.office_name}</>;
    case 'stage': return <>{key} {stageName(e.to ?? 0)}</>;
    case 'corrected': return <>{key} corrected {euro(e.from)} → {euro(e.to)}</>;
    case 'superseded': return <>{key} superseded, kept, not summed</>;
    case 'duplicate': return <>{e.filename ?? 'a file'} again in {e.office_name}: duplicate</>;
    case 'summary': return <>{e.office_name} summary rewritten</>;
    case 'error': return <>{key} failed: {e.error}</>;
  }
}

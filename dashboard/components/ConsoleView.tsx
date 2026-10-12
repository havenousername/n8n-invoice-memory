'use client';
// The presenter screen: controls in a rail, and what n8n is doing with the latest document across both shards.
import { useCallback, useMemo, useState } from 'react';
import { stageName } from '@/lib/format';
import type { ManagerId } from '@/lib/offices';
import { pipelineState, sourceOf } from '@/lib/pipeline';
import { pickSpotlight } from '@/lib/spotlight';
import { DayControls } from './DayControls';
import { Live } from './ManagerView';
import { PasscodeGate } from './PasscodeGate';
import { PipelineFlow } from './PipelineFlow';
import { SendPanel } from './SendPanel';
import { Stage } from './Stage';
import { useOfficeFeed } from './useOfficeFeed';

const BOTH: ManagerId[] = ['m_anna', 'm_ben'];

export function ConsoleView() {
  const managers = useMemo(() => BOTH, []);
  const feed = useOfficeFeed(managers);
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const onSent = useCallback((file: string) => setSent((s) => new Set(s).add(file)), []);
  if (feed.locked) return <PasscodeGate onUnlocked={feed.unlock} />;

  const spot = pickSpotlight(feed.cards ?? [], feed.tape, feed.now);
  const focus = spot.kind === 'idle' ? null : spot;
  const state = focus ? pipelineState(focus.document, focus.office, sourceOf(focus.document, sent)) : null;
  const doc = focus?.document;
  const last = feed.tape[0];
  return (
    <Stage>
      <div className="shell">
        <header className="header">
          <span className="brand-name">Q8nten</span>
          <span className="brand-sub">Console · what <b className="n8n">n8n</b> is doing</span>
          <span className="header-spacer" />
          <Live feed={feed} />
        </header>
        <main className="console">
          <aside className="panel rail">
            <SendPanel onSent={onSent} />
            <DayControls />
          </aside>
          <section className="panel canvas" aria-label="What n8n is doing">
            <header className="canvas-head">
              <p className="eyebrow">What n8n is doing</p>
              <span className="hint">{doc
                ? <><b className="mono">{doc.doc_key ?? doc.filename}</b> · {focus.office.name} · {doc.kind === 'duplicate' ? 'duplicate' : stageName(doc.stage)}</>
                : <b>Send a document.</b>}</span>
            </header>
            <PipelineFlow state={state} docKey={doc?.document_id ?? ''} times={doc ? feed.times[doc.document_id] ?? {} : {}} pointName={focus?.office.name ?? 'event'} />
            {last && <p className="last-event">last: {last.office_name} · {last.doc_key ?? last.filename ?? 'document'} · {last.kind}</p>}
          </section>
        </main>
      </div>
    </Stage>
  );
}

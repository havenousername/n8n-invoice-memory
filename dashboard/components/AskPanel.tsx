'use client';
import { ChevronsLeft, ChevronsRight, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { normalizeQuery, parseOver } from '@/lib/ask';
import type { LensResults } from '@/lib/shape';
import { LENSES, LensAnswer, type LensKey } from './LensColumns';

export type Answer = { lenses: LensResults; took_ms: number; query: string; manager: string };
const EXAMPLES = ['PO-1042', 'LED walls for the keynote stage', 'which event is over plan on catering?'];

type Props = {
  manager: string; answer: Answer | null; onAnswer: (answer: Answer | null) => void;
  lens: LensKey; onLens: (lens: LensKey) => void; open: boolean; onToggle: () => void;
};

/** Ask the memory: one Qdrant batch request; the switch shows what each representation answers. */
export function AskPanel({ manager, answer, onAnswer, lens, onLens, open, onToggle }: Props) {
  const [text, setText] = useState('');
  const [over, setOver] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string, e?: FormEvent) {
    e?.preventDefault();
    const query = normalizeQuery(q);
    const threshold = parseOver(over);
    if (!query) return setError('Type a question, a key like PO-1042, or a supplier.');
    if (threshold === 'invalid') return setError('The threshold is a whole number of euros, like 1000.');
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({ manager, q: query, ...(threshold !== null ? { over: String(threshold) } : {}) });
      const response = await fetch(`/api/ask?${params}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `ask failed (${response.status})`);
      onAnswer({ lenses: body.lenses, took_ms: body.took_ms, query, manager });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="panel ask-tab" onClick={onToggle} aria-label="Open Ask the memory">
        <ChevronsLeft size={20} aria-hidden="true" /><span>Ask the memory</span><Search size={20} aria-hidden="true" />
      </button>
    );
  }
  return (
    <section className="panel ask" aria-label="Ask the memory">
      <header className="canvas-head">
        <p className="eyebrow">Ask the memory</p>
        <button type="button" className="icon-btn" onClick={onToggle} aria-label="Hide Ask the memory"><ChevronsRight size={20} aria-hidden="true" /></button>
      </header>
      <form className="ask-form" onSubmit={(e) => ask(text, e)}>
        <label className="sr-only" htmlFor="ask-q">Question, key, or supplier</label>
        <input id="ask-q" className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="LED walls for the keynote stage" />
        <button className="btn" type="submit" disabled={busy}>{busy ? '…' : 'Ask'}</button>
        <label className="over-field">over plan by
          <input className="input num" value={over} onChange={(e) => setOver(e.target.value)} inputMode="numeric" placeholder="any €" />
        </label>
      </form>
      <div className="examples">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" className="example" disabled={busy} onClick={() => { setText(example); void ask(example); }}>{example}</button>
        ))}
      </div>
      {error && <p className="ask-error" role="alert">{error}</p>}
      <div className="switch wide" role="tablist" aria-label="Representation">
        {LENSES.map(({ key, name, Icon }) => (
          <button key={key} type="button" role="tab" aria-selected={lens === key} onClick={() => onLens(key)} style={{ ['--lens-color' as string]: LENSES.find((l) => l.key === key)!.color }}>
            <Icon size={16} aria-hidden="true" /> {name}
          </button>
        ))}
      </div>
      <div id={`lens-${lens}`} className="answer-slot">
        {answer ? <LensAnswer lenses={answer.lenses} lens={lens} /> : <p className="hint"><b>Ask anything.</b> The same events, stored two ways, answer differently.</p>}
      </div>
      {answer && <p className="answer-meta"><span className="num">{(answer.took_ms / 1000).toFixed(1)} s</span> · <b>0 model calls</b></p>}
    </section>
  );
}

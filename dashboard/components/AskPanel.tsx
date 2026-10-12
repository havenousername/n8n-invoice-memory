'use client';
import { Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { normalizeQuery, parseOver } from '@/lib/ask';
import type { LensResults } from '@/lib/shape';
import { LensColumns } from './LensColumns';

export type Answer = { lenses: LensResults; took_ms: number; query: string };
const EXAMPLES = ['PO-1042', 'GPU servers for the launch', 'which office overspends on travel?'];

type Props = { manager: string; answer: Answer | null; onAnswer: (answer: Answer | null) => void };

/** Ask the memory: the browser sends text; the server runs one Qdrant batch with four searches. */
export function AskPanel({ manager, answer, onAnswer }: Props) {
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
      onAnswer({ lenses: body.lenses, took_ms: body.took_ms, query });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Ask the memory">
      <h2 className="panel-title"><Search size={18} aria-hidden="true" /> Ask the memory</h2>
      <form className="ask-form" onSubmit={(e) => ask(text, e)}>
        <label className="field">Question, key, or supplier
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="GPU servers for the launch" />
        </label>
        <label className="field">Over plan by
          <input className="input num" value={over} onChange={(e) => setOver(e.target.value)} inputMode="numeric" placeholder="any €" />
        </label>
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Asking…' : 'Ask'}</button>
      </form>
      <div className="examples">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" className="example" disabled={busy} onClick={() => { setText(example); void ask(example); }}>{example}</button>
        ))}
      </div>
      {error && <p className="ask-error" role="alert">{error}</p>}
      {answer && <LensColumns key={`${answer.query}-${answer.took_ms}`} lenses={answer.lenses} tookMs={answer.took_ms} />}
      <p className="caption">Three representations of every office, each answering a different question. Qdrant fuses them in one request.</p>
    </section>
  );
}

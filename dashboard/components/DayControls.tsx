'use client';
import { Play, RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';

const post = async (path: string, body: unknown = {}) => {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error ?? `${path} failed (${response.status})`);
  return answer;
};

/** The AI working day (00) and the reset between rehearsals (07); reset asks twice, inline, never in a dialog. */
export function DayControls() {
  const [count, setCount] = useState(12);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  async function run(label: string, path: string, body?: unknown, done?: string) {
    setBusy(label);
    try { await post(path, body); setStatus(done ?? null); }
    catch (error) { setStatus((error as Error).message); }
    finally { setBusy(null); }
  }
  return (
    <>
      <section className="rail-section" aria-label="AI working day">
        <p className="eyebrow">AI working day</p>
        <p className="rail-note">AI workers file documents into the offices, one every ~15 s.</p>
        <div className="day-row">
          <label className="count">documents
            <input className="input num" type="number" min={1} max={40} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
          <button type="button" className="btn" disabled={busy !== null}
            onClick={() => run('start', '/api/day/start', { count }, `day started: ${count} documents`)}><Play size={18} aria-hidden="true" /> Start</button>
          <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => run('stop', '/api/day/stop', {}, 'stopping after the current document')}>
            <Square size={16} aria-hidden="true" /> Stop</button>
        </div>
        {status && <p className="rail-status" role="status">{status}</p>}
      </section>
      <section className="rail-section reset" aria-label="Reset">
        {confirming ? (
          <div className="confirm">
            <span>Clear every document and start the offices empty?</span>
            <button type="button" className="btn danger" disabled={busy !== null}
              onClick={() => { setConfirming(false); void run('reset', '/api/reset', {}, 'reset: six empty offices'); }}>Reset</button>
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="btn ghost" onClick={() => setConfirming(true)}><RotateCcw size={16} aria-hidden="true" /> Reset between rehearsals…</button>
        )}
      </section>
    </>
  );
}

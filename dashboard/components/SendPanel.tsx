'use client';
import { useState } from 'react';
import { BOOTH_POOL } from '@/lib/pool';

/** The booth beats in the order they are told: the original, a second office, the same file again, the amendment. */
const BEATS = ['ber-po-1042-v1.pdf', 'muc-po-2041-v1.pdf', 'ber-po-1042-v1-copy.pdf', 'ber-po-1042-v2.pdf'];
type Result = { state: 'sending' } | { state: 'done'; text: string; tone: 'ok' | 'dup' } | { state: 'error'; text: string };

export function SendPanel({ onSent }: { onSent: (file: string) => void }) {
  const [results, setResults] = useState<Record<string, Result>>({});
  async function send(file: string) {
    setResults((r) => ({ ...r, [file]: { state: 'sending' } }));
    onSent(file);
    try {
      const response = await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `send failed (${response.status})`);
      setResults((r) => ({ ...r, [file]: body.status === 'duplicate'
        ? { state: 'done', text: `duplicate of ${body.filename}`, tone: 'dup' }
        : { state: 'done', text: `received in ${body.office_id}`, tone: 'ok' } }));
    } catch (error) {
      setResults((r) => ({ ...r, [file]: { state: 'error', text: (error as Error).message } }));
    }
  }
  return (
    <section className="rail-section" aria-label="Send a booth document">
      <p className="eyebrow">Send a booth document</p>
      <ol className="beats">
        {BEATS.map((file, i) => {
          const doc = BOOTH_POOL.find((d) => d.file === file)!;
          const result = results[file];
          return (
            <li key={file}>
              <button type="button" className="beat" disabled={result?.state === 'sending'} onClick={() => send(file)}>
                <span className="beat-n num">{i + 1}</span>
                <span className="beat-text"><b>{doc.office}</b> · {doc.label}</span>
              </button>
              {result && result.state !== 'sending' && (
                <span className="beat-result" data-tone={result.state === 'error' ? 'error' : result.tone}>{result.text}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

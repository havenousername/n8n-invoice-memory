'use client';
import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';

/** The booth passcode; the server answers with an httpOnly session cookie. */
export function PasscodeGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode }) })
      .catch(() => null);
    setBusy(false);
    if (response?.ok) onUnlocked();
    else setError(response?.status === 401 ? 'That passcode is not right.' : 'The dashboard server is not reachable.');
  }
  return (
    <main className="gate">
      <form onSubmit={submit}>
        <h1><Lock size={26} aria-hidden="true" /> Q8nten</h1>
        <p>Enter the booth passcode.</p>
        <label className="field">Passcode
          <input className="input" type="password" autoComplete="current-password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoFocus />
        </label>
        {error && <p className="ask-error" role="alert">{error}</p>}
        <button className="btn" type="submit" disabled={busy || !passcode}>{busy ? 'Checking…' : 'Open the dashboard'}</button>
      </form>
    </main>
  );
}

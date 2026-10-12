import { describe, expect, it } from 'vitest';
import { createPoller } from './poll';

// A manual clock: timers run only when the test says so.
function harness(fetchOnce: (key: string) => Promise<unknown>) {
  const timers: { at: number; fn: () => void }[] = [];
  let time = 0;
  const data: [string, unknown][] = [];
  const errors: [number, boolean][] = [];
  const poller = createPoller({
    fetchOnce,
    intervalMs: 2000,
    onData: (key, value) => data.push([key, value]),
    onError: (failures, offline) => errors.push([failures, offline]),
    now: () => time,
    setTimer: (fn, ms) => {
      const timer = { at: time + ms, fn };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  });
  const advance = async (ms: number) => {
    time += ms;
    for (const t of timers.filter((t) => t.at <= time)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  };
  return { poller, data, errors, advance, timers };
}

const deferred = () => {
  let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('createPoller', () => {
  it('polls at once, then 2 s after each response settles, one request at a time', async () => {
    const calls: string[] = [];
    const pending: ReturnType<typeof deferred>[] = [];
    const h = harness((key) => { calls.push(key); const d = deferred(); pending.push(d); return d.promise as Promise<unknown>; });
    h.poller.start('m_anna');
    expect(calls).toEqual(['m_anna']);
    await h.advance(5000);
    expect(calls).toHaveLength(1); // still in flight: no second request
    pending[0].resolve('a1');
    await h.advance(0);
    expect(h.data).toEqual([['m_anna', 'a1']]);
    await h.advance(1999);
    expect(calls).toHaveLength(1);
    await h.advance(1);
    expect(calls).toHaveLength(2);
  });

  it('drops a response for a manager that is no longer current', async () => {
    const pending: Record<string, ReturnType<typeof deferred>> = {};
    const h = harness((key) => { pending[key] = deferred(); return pending[key].promise as Promise<unknown>; });
    h.poller.start('m_anna');
    h.poller.setKey('m_ben');
    pending.m_ben.resolve('ben');
    await h.advance(0);
    pending.m_anna.resolve('anna, late');
    await h.advance(0);
    expect(h.data).toEqual([['m_ben', 'ben']]);
  });

  it('goes offline after three failures in a row and recovers on success', async () => {
    let fail = true;
    const h = harness(async () => { if (fail) throw new Error('down'); return 'ok'; });
    h.poller.start('m_anna');
    await h.advance(0);
    await h.advance(2000);
    await h.advance(2000);
    expect(h.errors).toEqual([[1, false], [2, false], [3, true]]);
    fail = false;
    await h.advance(2000);
    expect(h.data).toEqual([['m_anna', 'ok']]);
    await h.advance(2000);
    expect(h.errors).toHaveLength(3);
  });

  it('stop cancels the next poll', async () => {
    let calls = 0;
    const h = harness(async () => { calls += 1; return calls; });
    h.poller.start('m_anna');
    await h.advance(0);
    h.poller.stop();
    await h.advance(10_000);
    expect(calls).toBe(1);
  });
});

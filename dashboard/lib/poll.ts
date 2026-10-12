// The dashboard's only clock: one request at a time, the next one 2 s after the last settles. Every key (a manager,
// or a manager with a query) has a generation; a response for an older generation is dropped.

export type PollerOptions<T> = {
  fetchOnce: (key: string) => Promise<T>;
  intervalMs: number;
  onData: (key: string, data: T) => void;
  onError: (failures: number, offline: boolean) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
};

export const OFFLINE_AFTER = 3;

const defaultTimer = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createPoller<T>({ fetchOnce, intervalMs, onData, onError, setTimer = defaultTimer }: PollerOptions<T>) {
  let key: string | null = null;
  let generation = 0;
  let failures = 0;
  let cancelTimer: (() => void) | null = null;

  const schedule = () => {
    cancelTimer?.();
    cancelTimer = setTimer(() => { cancelTimer = null; void tick(); }, intervalMs);
  };

  async function tick() {
    if (key === null) return;
    const mine = generation;
    const current = key;
    try {
      const data = await fetchOnce(current);
      if (mine !== generation) return;
      failures = 0;
      onData(current, data);
    } catch {
      if (mine !== generation) return;
      failures += 1;
      onError(failures, failures >= OFFLINE_AFTER);
    }
    if (mine === generation) schedule();
  }

  function start(next: string) {
    key = next;
    generation += 1;
    cancelTimer?.();
    void tick();
  }

  function stop() {
    key = null;
    generation += 1;
    cancelTimer?.();
    cancelTimer = null;
  }

  return { start, setKey: start, stop };
}

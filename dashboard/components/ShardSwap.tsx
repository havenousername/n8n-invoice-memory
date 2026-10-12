'use client';
import { MANAGER_NAMES, type ManagerId } from '@/lib/offices';

/** The manager pills: each manager is a tenant with its own shard; switching reads the other shard only. */
export function ShardSwap({ manager, swappedFrom, onSwitch }: { manager: ManagerId; swappedFrom: ManagerId | null; onSwitch: (m: ManagerId) => void }) {
  return (
    <>
      <div className="pills" role="group" aria-label="Manager">
        {(Object.keys(MANAGER_NAMES) as ManagerId[]).map((id) => (
          <button key={id} type="button" className="pill" aria-pressed={id === manager} onClick={() => onSwitch(id)}>
            {MANAGER_NAMES[id].name}<small>{MANAGER_NAMES[id].region}</small>
          </button>
        ))}
      </div>
      {swappedFrom && <span key={`${swappedFrom}-${manager}`} className="shard-chip mono">shard {swappedFrom} → {manager}</span>}
    </>
  );
}

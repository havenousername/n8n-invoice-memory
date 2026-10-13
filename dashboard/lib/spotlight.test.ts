import { describe, expect, it } from 'vitest';
import type { DashboardEvent } from './events';
import { berlin, doc } from './fixtures';
import { toOfficeCard, type OfficePayload } from './shape';
import { ATTENTION_MS, pickSpotlight } from './spotlight';

const NOW = Date.parse('2026-10-14T09:10:00Z');
const card = (fields: Partial<OfficePayload>) => toOfficeCard({ id: fields.office_id ?? 'berlin', payload: berlin(fields) });
const event = (kind: DashboardEvent['kind'], document_id: string, atMs: number): DashboardEvent & { seenAt: number } =>
  ({ kind, office_id: 'berlin', office_name: 'DevSummit Berlin', at: '', document_id, seenAt: atMs });

describe('pickSpotlight', () => {
  it('a failed read comes first', () => {
    const cards = [card({ documents: [doc({ document_id: 'run', stage: 1 }), doc({ document_id: 'bad', stage: -1, error: 'timeout' })] })];
    expect(pickSpotlight(cards, [], NOW)).toMatchObject({ kind: 'error', document: { document_id: 'bad' }, office: { office_id: 'berlin' } });
  });
  it('then the newest document still being read', () => {
    const cards = [
      card({ documents: [doc({ document_id: 'a', stage: 0, status: 'pending', received_at: '2026-10-14T09:00:00Z' })] }),
      card({ office_id: 'munich', name: 'Munich', documents: [doc({ document_id: 'b', stage: 1, received_at: '2026-10-14T09:05:00Z' })] }),
    ];
    expect(pickSpotlight(cards, [], NOW)).toMatchObject({ kind: 'running', document: { document_id: 'b' }, office: { office_id: 'munich' } });
  });
  it('a duplicate is never "running", even at stage 0', () => {
    const cards = [card({ documents: [doc({ document_id: 'v1' }), doc({ document_id: 'copy', kind: 'duplicate', stage: 0, status: 'duplicate', received_at: '2026-10-14T09:09:00Z' })] })];
    expect(pickSpotlight(cards, [], NOW).kind).not.toBe('running');
  });
  it('then a fresh duplicate or amendment needs attention, for a while', () => {
    const cards = [card({ documents: [doc({ document_id: 'v1', status: 'superseded' }), doc({ document_id: 'v2', version: 2 })] })];
    const recent = [event('superseded', 'v1', NOW - 5000)];
    expect(pickSpotlight(cards, recent, NOW)).toMatchObject({ kind: 'attention', reason: 'superseded', document: { document_id: 'v1' } });
    expect(pickSpotlight(cards, recent, NOW + ATTENTION_MS).kind).toBe('latest');
  });
  it('otherwise the latest document, flagged when its office went over plan', () => {
    const cards = [card({ documents: [doc({ document_id: 'd1', category: 'gpu' })] })];
    expect(pickSpotlight(cards, [], NOW)).toMatchObject({ kind: 'latest', document: { document_id: 'd1' }, overPlan: true });
  });
  it('with no documents at all, idle', () => {
    expect(pickSpotlight([card({ documents: [], latest: null })], [], NOW)).toEqual({ kind: 'idle' });
    expect(pickSpotlight([], [], NOW)).toEqual({ kind: 'idle' });
  });
});

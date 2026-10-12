import { describe, expect, it } from 'vitest';
import { diffOffices } from './events';
import { berlin, doc } from './fixtures';
import { toOfficeCard } from './shape';
import type { OfficePayload } from './shape';

const card = (payload: OfficePayload) => toOfficeCard({ id: payload.office_id, payload });

describe('diffOffices', () => {
  it('the first load raises no events', () => {
    expect(diffOffices(null, [card(berlin())])).toEqual([]);
  });

  it('a new document is received; a new duplicate row is a duplicate', () => {
    const before = card(berlin({ documents: [] }));
    const after = card(berlin({ documents: [doc({ document_id: 'd1', stage: 0, status: 'pending', amount: null }),
      doc({ document_id: 'd2', kind: 'duplicate', duplicate_of: 'd1', status: 'duplicate', stage: 0 })] }));
    expect(diffOffices([before], [after]).map((e) => [e.kind, e.document_id])).toEqual([['received', 'd1'], ['duplicate', 'd2']]);
  });

  it('a rough read and then its correction', () => {
    const received = card(berlin({ documents: [doc({ document_id: 'd1', stage: 0, status: 'pending', amount: null })] }));
    const rough = card(berlin({ documents: [doc({ document_id: 'd1', stage: 1, amount: 48 })] }));
    const sharp = card(berlin({ documents: [doc({ document_id: 'd1', stage: 2, amount: 48000 })] }));
    expect(diffOffices([received], [rough])).toMatchObject([{ kind: 'stage', from: 0, to: 1, document_id: 'd1' }]);
    expect(diffOffices([rough], [sharp])).toMatchObject([
      { kind: 'stage', from: 1, to: 2 },
      { kind: 'corrected', from: 48, to: 48000, doc_key: 'PO-1042' },
    ]);
  });

  it('an amendment supersedes the older version', () => {
    const before = card(berlin({ documents: [doc({ document_id: 'v1' })] }));
    const after = card(berlin({ documents: [doc({ document_id: 'v1', status: 'superseded' }), doc({ document_id: 'v2', version: 2, stage: 0, status: 'pending' })] }));
    expect(diffOffices([before], [after]).map((e) => e.kind)).toEqual(['superseded', 'received']);
  });

  it('a failed read is an error with its message', () => {
    const before = card(berlin({ documents: [doc({ document_id: 'd1', stage: 1, amount: 48 })] }));
    const after = card(berlin({ documents: [doc({ document_id: 'd1', stage: -1, amount: 48, error: 'vision reply is not bare JSON' })] }));
    expect(diffOffices([before], [after])).toMatchObject([{ kind: 'error', error: 'vision reply is not bare JSON' }]);
  });

  it('a summary that became fresh or was rewritten', () => {
    const stale = card(berlin({ summary_stage: 1, summary_text: 'mechanical' }));
    const fresh = card(berlin({ summary_stage: 3, summary_text: 'Berlin is over plan.' }));
    const rewritten = card(berlin({ summary_stage: 3, summary_text: 'Berlin amended PO-1042.' }));
    expect(diffOffices([stale], [fresh]).map((e) => e.kind)).toEqual(['summary']);
    expect(diffOffices([fresh], [rewritten]).map((e) => e.kind)).toEqual(['summary']);
    expect(diffOffices([fresh], [fresh])).toEqual([]);
  });

  it('an office that was not there before raises nothing (manager switch)', () => {
    expect(diffOffices([card(berlin())], [card(berlin({ office_id: 'paris', manager_id: 'm_ben' }))])).toEqual([]);
  });
});

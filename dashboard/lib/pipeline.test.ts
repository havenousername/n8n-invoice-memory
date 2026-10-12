import { describe, expect, it } from 'vitest';
import { berlin, doc } from './fixtures';
import { pipelineState, sourceOf } from './pipeline';
import { toOfficeCard, type OfficePayload } from './shape';

const office = (fields: Partial<OfficePayload> = {}) => toOfficeCard({ id: 'p', payload: berlin(fields) });

describe('sourceOf', () => {
  it('a booth file sent from the Console, a booth file from the Form, anything else from the AI workers', () => {
    const sent = new Set(['ber-po-1042-v1.pdf']);
    expect(sourceOf(doc({ document_id: 'a', filename: 'ber-po-1042-v1.pdf' }), sent)).toBe('console');
    expect(sourceOf(doc({ document_id: 'b', filename: 'muc-po-2041-v1.pdf' }), sent)).toBe('form');
    expect(sourceOf(doc({ document_id: 'c', filename: 'ber-po-1042-v1-copy.pdf' }), new Set(['ber-po-1042-v1-copy.pdf']))).toBe('console');
    expect(sourceOf(doc({ document_id: 'd', filename: 'lon-po-5000-v1.pdf' }), sent)).toBe('ai');
  });
});

describe('pipelineState', () => {
  it('a received document has reached Record', () => {
    expect(pipelineState(doc({ document_id: 'a', stage: 0, status: 'pending' }), office({ pending_count: 1 }), 'ai'))
      .toEqual({ path: ['ai', 'record'], active: 'record', failed: false });
  });
  it('each stage moves one node further along Process', () => {
    expect(pipelineState(doc({ document_id: 'a', stage: 1 }), office({ pending_count: 1 }), 'form').path).toEqual(['form', 'record', 'rough']);
    expect(pipelineState(doc({ document_id: 'a', stage: 2 }), office({ summary_stage: 1 }), 'form').active).toBe('vision');
  });
  it('a fresh summary for a fully read office ends at Summary', () => {
    expect(pipelineState(doc({ document_id: 'a', stage: 2 }), office({ summary_stage: 3, pending_count: 0 }), 'console').path)
      .toEqual(['console', 'record', 'rough', 'vision', 'summary']);
  });
  it('a duplicate goes from Record straight to Rebuild, never through Process', () => {
    expect(pipelineState(doc({ document_id: 'd', kind: 'duplicate', stage: 0, status: 'duplicate' }), office(), 'console'))
      .toEqual({ path: ['console', 'record', 'rebuild'], active: 'rebuild', failed: false });
  });
  it('a failed read stops at Vision, marked failed', () => {
    expect(pipelineState(doc({ document_id: 'e', stage: -1, error: 'timeout' }), office(), 'ai'))
      .toEqual({ path: ['ai', 'record', 'rough', 'vision'], active: 'vision', failed: true });
  });
});

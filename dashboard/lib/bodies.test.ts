import { describe, expect, it } from 'vitest';
import reference from './reference-bodies.json';
import { askBatch, officeList, officeScroll } from './bodies';

// scripts/bodies.py --json writes these cases; the dashboard must send the same JSON for the same arguments.
describe('request bodies match the Python reference', () => {
  it('officeList', () => {
    for (const { args, body } of reference.office_list) {
      expect(officeList(...(args as Parameters<typeof officeList>))).toEqual(body);
    }
  });
  it('officeScroll', () => {
    for (const { args, body } of reference.office_scroll) {
      expect(officeScroll(...(args as Parameters<typeof officeScroll>))).toEqual(body);
    }
  });
  it('askBatch', () => {
    for (const { args, body } of reference.ask_batch) {
      expect(askBatch(...(args as Parameters<typeof askBatch>))).toEqual(body);
    }
  });
});

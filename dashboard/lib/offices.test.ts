import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROLLERS, MANAGER_NAMES } from './offices';

describe('office metadata', () => {
  it('controllers and managers equal samples/offices.json', () => {
    const offices = JSON.parse(readFileSync(join(__dirname, '..', '..', 'samples', 'offices.json'), 'utf8'));
    for (const o of offices) {
      expect(CONTROLLERS[o.office_id]).toBe(o.worker_name);
      expect(MANAGER_NAMES[o.manager_id as keyof typeof MANAGER_NAMES]).toEqual({ name: o.manager_name, region: o.region });
    }
    expect(Object.keys(CONTROLLERS)).toHaveLength(offices.length);
  });
});

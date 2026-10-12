import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOTH_POOL } from './pool';

describe('the booth pool', () => {
  it('equals the booth documents of samples/manifest.json, in order', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'samples', 'manifest.json'), 'utf8'));
    expect(BOOTH_POOL.map((d) => d.file)).toEqual(manifest.filter((r: { role: string }) => r.role === 'booth').map((r: { file: string }) => r.file));
  });
});

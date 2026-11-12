import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'not-yet.mjs');

describe('not-yet.mjs placeholder', () => {
  it('exits 1 and names the script and the ticket', () => {
    const result = spawnSync(process.execPath, [script, 'dev', '4'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"dev" is not implemented until ticket 4.');
  });
});

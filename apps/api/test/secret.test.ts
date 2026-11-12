import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { Secret } from '../src/secret';

const marker = randomBytes(24).toString('hex');

describe('Secret', () => {
  it('returns the value only from reveal', () => {
    expect(new Secret(marker).reveal()).toBe(marker);
  });

  it('shows [redacted] however it is turned into text', () => {
    const secret = new Secret(marker);
    const outputs = [JSON.stringify(secret), JSON.stringify({ nested: { secret } }), `${secret}`, String(secret), inspect(secret), inspect({ secret }, { depth: 5 })];
    for (const output of outputs) {
      expect(output).toContain('[redacted]');
      expect(output).not.toContain(marker);
    }
  });

  it('keeps the value out of a failing equality diff on a config', () => {
    const result = loadConfig({ DB_USER: 'app_user', DB_PASSWORD: marker, DB_NAME: 'app_db' });
    if (!result.ok) throw new Error('config should be valid');
    let failure = '';
    try {
      expect(result.config).toEqual({ dbHost: 'other' });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).not.toBe('');
    expect(failure).not.toContain(marker);
  });
});

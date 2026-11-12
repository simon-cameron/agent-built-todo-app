import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { runMain } from '../src/fatal';
import { buildTestConfig } from './db-setup';
import { freePort } from './free-port';
import { captureLogger } from './log-capture';

const generated = (): string => randomBytes(24).toString('hex');

async function runWithPassword(password: string, overrides: Parameters<typeof runMain>[0]['startOverrides'] = {}) {
  const base = buildTestConfig();
  const errors: string[] = [];
  const exits: number[] = [];
  const signals = new EventEmitter();
  const capture = captureLogger();
  await runMain({
    env: { DB_USER: base.dbUser, DB_PASSWORD: password, DB_NAME: base.dbName, DB_HOST: base.dbHost, DB_PORT: String(base.dbPort), API_PORT: String(await freePort()) },
    writeError: (text) => errors.push(text),
    exit: (code) => exits.push(code),
    signals,
    logger: capture.logger,
    startOverrides: overrides,
  });
  return { output: errors.join('') + capture.lines.join('\n'), exits, signals };
}

describe('the password never reaches output', () => {
  it('on a failed probe with a marker password', async () => {
    const marker = generated();
    const { output, exits } = await runWithPassword(marker, {
      probe: async () => {
        throw Object.assign(new Error(`bad ${marker}`), { code: 'XX000', detail: marker });
      },
    });
    expect(exits).toEqual([1]);
    expect(output).not.toContain(marker);
  });

  it('on a configuration failure', async () => {
    const marker = generated().slice(0, 8);
    const { output, exits } = await runWithPassword(marker);
    expect(exits).toEqual([1]);
    expect(output).not.toContain(marker);
  });

  it('on a successful start and stop, even though the pool is built with the marker', async () => {
    const real = buildTestConfig().dbPassword.reveal();
    const { output, exits, signals } = await runWithPassword(real, { migrate: async () => undefined, probe: async () => undefined });
    signals.emit('SIGTERM');
    await expect.poll(() => exits.length).toBe(1);
    expect(exits).toEqual([0]);
    expect(output).not.toContain(real);
  });
});

describe('the logger redacts password fields as a second layer', () => {
  it('replaces password and dbPassword values, at the top level and nested', () => {
    const marker = generated();
    const lines: string[] = [];
    const logger = createLogger({ write: (chunk: string) => void lines.push(chunk) });
    logger.info({ password: marker, dbPassword: marker, config: { password: marker, dbPassword: marker } }, 'check');
    expect(lines.join('')).not.toContain(marker);
    expect(lines.join('')).toContain('[redacted]');
  });

  it('keeps a Secret out of a log line without redaction paths', () => {
    const marker = generated();
    const result = loadConfig({ DB_USER: 'app_user', DB_PASSWORD: marker, DB_NAME: 'app_db' });
    if (!result.ok) throw new Error('config should be valid');
    const lines: string[] = [];
    const logger = createLogger({ write: (chunk: string) => void lines.push(chunk) });
    logger.info({ config: result.config }, 'config');
    expect(lines.join('')).not.toContain(marker);
  });
});

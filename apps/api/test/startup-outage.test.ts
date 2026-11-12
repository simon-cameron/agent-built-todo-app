import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool';
import { runMain } from '../src/fatal';
import { buildTestConfig } from './db-setup';
import { startDbProxy, type DbProxy } from './db-proxy';
import { freePort } from './free-port';
import { captureLogger } from './log-capture';
import { rawSocket } from './request';

/*
 * AC5, the variant with a real database path: runMain with a short injected wait, the real timer and the proxy standing in for the database.
 * Nothing here calls process.exit or writes to the real stdout: exit and writeError are stubs, the logger writes to memory.
 */

const proxies: DbProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function startupHarness(password: string) {
  const base = buildTestConfig();
  const proxy = await startDbProxy({ host: base.dbHost, port: base.dbPort });
  proxies.push(proxy);
  const apiPort = await freePort();
  const env = { DB_USER: base.dbUser, DB_PASSWORD: password, DB_NAME: base.dbName, DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port), API_PORT: String(apiPort) };
  const capture = captureLogger();
  // The pool is handed in so the test can see that a failed start ends it.
  const pool = createPool(buildTestConfig({ ...process.env, ...env }), capture.logger);
  const errors: string[] = [];
  const exits: number[] = [];
  const signals = new EventEmitter();
  const run = (startOverrides: { waitMs: number; intervalMs: number }) =>
    runMain({ env, writeError: (text) => errors.push(text), exit: (code) => exits.push(code), signals, logger: capture.logger, startOverrides: { ...startOverrides, pool } });
  const attemptLines = () => capture.records().filter((record) => record.msg === 'database not reachable yet');
  return { proxy, apiPort, capture, pool, errors, exits, signals, run, attemptLines };
}

describe('the database is down when the API starts', () => {
  it('retries once per attempt, then fails fast with the documented message and exit code 1', async ({ annotate }) => {
    const secret = randomBytes(12).toString('hex');
    const h = await startupHarness(secret);
    h.proxy.cut();
    const waitMs = 1000;
    const intervalMs = 200;

    const started = performance.now();
    await h.run({ waitMs, intervalMs });
    const elapsedMs = Math.round(performance.now() - started);
    await annotate(`startup, database down: failed after ${elapsedMs} ms (wait ${waitMs} ms, interval ${intervalMs} ms)`);

    const attempts = Math.floor(waitMs / intervalMs) + 1;
    const lines = h.attemptLines();
    expect(lines).toHaveLength(attempts);
    lines.forEach((line, index) => {
      expect(line).toMatchObject({ level: 'warn', attempt: index + 1, attempts, host: '127.0.0.1', port: h.proxy.port, err: { code: 'ECONNREFUSED' } });
      expect(Object.keys(line['err'] as object)).toEqual(['code']);
    });

    expect(h.errors).toHaveLength(1);
    const message = h.errors[0] ?? '';
    expect(message.startsWith(`The API cannot start: database unreachable at 127.0.0.1:${h.proxy.port} after ${attempts} attempts`)).toBe(true);
    expect(message.endsWith('Is it running? Start it with: docker compose up -d\n')).toBe(true);
    expect(h.exits).toEqual([1]);
    expect(h.capture.records().some((record) => record.msg === 'listening')).toBe(false);
    expect(h.pool.ended).toBe(true);
    await expect(rawSocket(h.apiPort, 'GET / HTTP/1.1\r\n\r\n')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(message + h.capture.lines.join('\n')).not.toContain(secret);
  }, 30_000);

  it('starts and listens when the database comes up mid-wait', async ({ annotate }) => {
    const password = buildTestConfig().dbPassword.reveal();
    const h = await startupHarness(password);
    h.proxy.cut();

    const started = performance.now();
    const running = h.run({ waitMs: 3000, intervalMs: 200 });
    await delay(700);
    await h.proxy.restore();
    await running;
    await annotate(`startup, database back about 700 ms in: listening after ${Math.round(performance.now() - started)} ms (wait 3000 ms)`);

    try {
      expect(h.exits).toEqual([]);
      expect(h.errors).toEqual([]);
      expect(h.attemptLines().length).toBeGreaterThanOrEqual(2);
      expect(h.attemptLines().length).toBeLessThanOrEqual(5);
      expect(h.capture.records().filter((record) => record.msg === 'listening')).toHaveLength(1);
      const response = await fetch(`http://127.0.0.1:${h.apiPort}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      h.signals.emit('SIGTERM');
      await expect.poll(() => h.exits.length, { timeout: 5000 }).toBe(1);
    }
    expect(h.exits).toEqual([0]);
    expect(h.pool.ended).toBe(true);
    expect(h.errors.join('') + h.capture.lines.join('\n')).not.toContain(password);
  }, 30_000);
});

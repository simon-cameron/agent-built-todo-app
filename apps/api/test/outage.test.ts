import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MESSAGE_BY_CODE } from '../src/errors';
import { spawnTsx } from './child';
import { buildTestConfig } from './db-setup';
import { startDbProxy } from './db-proxy';
import { freePort } from './free-port';
import type { LogRecord } from './log-capture';
import { health, outageTeardownAfterEach, poolErrorLines, pollForRecovery, requestLines, startOutageServer, watchForCrashes } from './outage';

outageTeardownAfterEach();

const UNAVAILABLE_BODY = { error: { code: 'database_unavailable', message: MESSAGE_BY_CODE.database_unavailable } };
const FRAME = /^ {4}at (?:node:|file:\/\/)?[A-Za-z0-9_\-./\\@+~%]+:\d+:\d+$/;

function expectFramesOnly(stack: unknown): void {
  expect(typeof stack).toBe('string');
  const lines = String(stack).split('\n');
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toMatch(FRAME);
}

describe('the database connection is cut and restored', () => {
  it('answers 503, stays alive, logs the failure, and recovers on the same app and pool within 30 seconds', async ({ annotate }) => {
    const crashes = watchForCrashes();
    try {
      const { proxy, port, capture, instance } = await startOutageServer();
      const { app, pool } = instance;
      expect((await health(port)).status).toBe(200);

      proxy.cut();

      // The idle pooled client lost its socket: the pool error listener runs and logs a code and a fixed message, never driver text.
      await expect.poll(() => poolErrorLines(capture.records()).length, { timeout: 5000 }).toBeGreaterThan(0);
      const poolLine = poolErrorLines(capture.records())[0] as LogRecord;
      expect(poolLine).toMatchObject({ level: 'error', err: { message: 'The database pool reported an error.' } });
      expect(Object.keys(poolLine['err'] as object).sort()).toEqual(['code', 'message']);

      // A new connection is refused for real (ECONNREFUSED), so this line carries a frames-only stack from a real driver error.
      const down = await health(port);
      expect(down.status).toBe(503);
      expect(down.body).toEqual(UNAVAILABLE_BODY);
      const line = requestLines(capture.records()).at(-1) as LogRecord;
      expect(line).toMatchObject({ level: 'error', status: 503, path: '/health', err: { code: 'ECONNREFUSED', message: MESSAGE_BY_CODE.database_unavailable } });
      expectFramesOnly((line['err'] as { stack: unknown }).stack);
      const logged = capture.lines.join('\n');
      expect(logged).not.toContain(`127.0.0.1:${proxy.port}`);
      expect(logged).not.toContain('ECONNREFUSED 127.');
      expect(logged).not.toContain(buildTestConfig().dbPassword.reveal());

      await proxy.restore();
      const recovery = await pollForRecovery(port);
      await annotate(`cut: back to 200 ${recovery.elapsedMs} ms after restore (${recovery.attempts} polls, limit 30000 ms)`);
      expect(recovery.elapsedMs).toBeLessThan(30_000);

      expect(instance.app).toBe(app);
      expect(instance.pool).toBe(pool);
      expect(pool.ended).toBe(false);
      expect(capture.records().filter((record) => record.msg === 'listening')).toHaveLength(1);
      expect(crashes.seen()).toEqual([]);
    } finally {
      crashes.stop();
    }
  }, 60_000);

  it('survives idle pooled connections being destroyed and opens a fresh connection afterwards', async ({ annotate }) => {
    const crashes = watchForCrashes();
    try {
      const { proxy, port, capture, instance } = await startOutageServer();
      await Promise.all([0, 1, 2].map(() => instance.pool.query('SELECT pg_sleep($1)', [0.3])));
      expect((await health(port)).status).toBe(200);
      const acceptedBefore = proxy.accepted();
      expect(acceptedBefore).toBeGreaterThanOrEqual(3);

      proxy.cut();
      await expect.poll(() => poolErrorLines(capture.records()).length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
      for (const line of poolErrorLines(capture.records())) {
        expect(line).toMatchObject({ level: 'error', err: { message: 'The database pool reported an error.' } });
        expect(Object.keys(line['err'] as object).sort()).toEqual(['code', 'message']);
      }

      await proxy.restore();
      const recovery = await pollForRecovery(port);
      await annotate(`edge: idle clients destroyed, back to 200 ${recovery.elapsedMs} ms after restore`);
      expect(proxy.accepted()).toBeGreaterThan(acceptedBefore);
      expect((await health(port)).status).toBe(200);
      expect(instance.pool.ended).toBe(false);
      expect(crashes.seen()).toEqual([]);
    } finally {
      crashes.stop();
    }
  }, 60_000);
});

describe('the real process through a database outage', () => {
  it('stays running, answers 503, recovers, leaks nothing and exits 0 on SIGTERM', async ({ annotate }) => {
    const config = buildTestConfig();
    const password = config.dbPassword.reveal();
    const secret = randomBytes(12).toString('hex');
    const proxy = await startDbProxy({ host: config.dbHost, port: config.dbPort });
    const port = await freePort();
    const child = spawnTsx(['src/index.ts'], {
      PATH: process.env['PATH'] ?? '',
      DB_USER: config.dbUser,
      DB_PASSWORD: password,
      DB_NAME: config.dbName,
      DB_HOST: '127.0.0.1',
      DB_PORT: String(proxy.port),
      API_PORT: String(port),
    });
    try {
      await expect.poll(() => child.stdout().includes('"msg":"listening"'), { timeout: 15_000, interval: 100 }).toBe(true);
      expect((await health(port, `?marker=${secret}`)).status).toBe(200);

      proxy.cut();
      const down = await health(port, `?marker=${secret}`);
      expect(down.status).toBe(503);
      expect(down.body).toEqual(UNAVAILABLE_BODY);
      expect(child.hasExited()).toBe(false);

      await proxy.restore();
      const recovery = await pollForRecovery(port);
      await annotate(`real process: back to 200 ${recovery.elapsedMs} ms after restore (limit 30000 ms)`);
      expect(child.hasExited()).toBe(false);

      child.terminate();
      expect(await child.exited).toBe(0);
      expect(child.stdout()).toContain('"msg":"shutting down"');
      expect(child.stderr()).toBe('');

      const output = child.stdout() + child.stderr();
      for (const forbidden of [secret, password, `127.0.0.1:${proxy.port}`, 'ECONNREFUSED 127.']) expect(output).not.toContain(forbidden);
      const lines = child.stdout().split('\n').filter((line) => line !== '');
      const errorLines = lines.map((line) => JSON.parse(line) as LogRecord).filter((record) => record.level === 'error');
      expect(errorLines.length).toBeGreaterThan(0);
      for (const record of errorLines) {
        const err = record['err'] as { stack?: unknown } | undefined;
        if (err?.stack !== undefined) expectFramesOnly(err.stack);
      }
    } finally {
      child.killGroup();
      await proxy.close();
    }
  }, 45_000);
});

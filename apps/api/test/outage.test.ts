import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
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

describe('a query is in flight when the connection is destroyed', () => {
  it('answers 503 with the fixed code CONNECTION_LOST, which pins the fourth driver text against the real driver', async ({ annotate }) => {
    const crashes = watchForCrashes();
    try {
      const holder: { pool?: pg.Pool } = {};
      const ctx = await startOutageServer((app) => {
        app.get('/slow', async () => {
          await holder.pool?.query('SELECT pg_sleep($1)', [3]);
          return { status: 'ok' };
        });
      });
      const { proxy, port, capture, instance } = ctx;
      holder.pool = instance.pool;
      const pending = fetch(`http://127.0.0.1:${port}/slow`, { signal: AbortSignal.timeout(20_000) });
      await delay(500);

      proxy.cut();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(UNAVAILABLE_BODY);
      const line = requestLines(capture.records()).at(-1) as LogRecord;
      expect(line).toMatchObject({ level: 'error', status: 503, path: '/slow', err: { code: 'CONNECTION_LOST', message: MESSAGE_BY_CODE.database_unavailable } });
      expectFramesOnly((line['err'] as { stack: unknown }).stack);

      await proxy.restore();
      const recovery = await pollForRecovery(port);
      await annotate(`cut under an in-flight query: 503 CONNECTION_LOST, back to 200 ${recovery.elapsedMs} ms after restore`);
      expect(instance.pool.ended).toBe(false);
      expect(crashes.seen()).toEqual([]);
    } finally {
      crashes.stop();
    }
  }, 60_000);
});

describe('the database accepts connections and never replies', () => {
  /** What every blackhole case must show after the failure: an error line, no crash, and the same app and pool serving 200 again. */
  async function expectRecovery(ctx: Awaited<ReturnType<typeof startOutageServer>>, label: string, annotate: (message: string) => Promise<unknown>, crashes: ReturnType<typeof watchForCrashes>) {
    const { proxy, port, capture, instance } = ctx;
    const { app, pool } = instance;
    await proxy.restore();
    const recovery = await pollForRecovery(port);
    await annotate(`${label}: back to 200 ${recovery.elapsedMs} ms after restore (${recovery.attempts} polls, limit 30000 ms)`);
    expect(recovery.elapsedMs).toBeLessThan(30_000);
    expect(instance.app).toBe(app);
    expect(instance.pool).toBe(pool);
    expect(pool.ended).toBe(false);
    expect(capture.records().filter((record) => record.msg === 'listening')).toHaveLength(1);
    expect(crashes.seen()).toEqual([]);
    expect(capture.lines.join('\n')).not.toContain(`127.0.0.1:${proxy.port}`);
  }

  it('answers 503 within the connection timeout when a new connection is never answered', async ({ annotate }) => {
    const crashes = watchForCrashes();
    try {
      const ctx = await startOutageServer();
      const { proxy, port, capture, instance } = ctx;
      // Leave the pool with no client, then listen again as a database that never answers.
      proxy.cut();
      await expect.poll(() => instance.pool.totalCount, { timeout: 5000 }).toBe(0);
      await proxy.restore();
      proxy.blackhole();

      const answer = await health(port);
      await annotate(`blackhole, new connection: 503 after ${answer.elapsedMs} ms (connection timeout 2000 ms)`);
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual(UNAVAILABLE_BODY);
      expect(answer.elapsedMs).toBeGreaterThanOrEqual(1500);
      expect(answer.elapsedMs).toBeLessThan(6000);
      expect(requestLines(capture.records()).at(-1)).toMatchObject({ level: 'error', status: 503, err: { code: 'CONNECT_TIMEOUT', message: MESSAGE_BY_CODE.database_unavailable } });

      await expectRecovery(ctx, 'blackhole, new connection', annotate, crashes);
    } finally {
      crashes.stop();
    }
  }, 60_000);

  it('answers 503 within the query timeout when a query on a warm client is never answered', async ({ annotate }) => {
    const crashes = watchForCrashes();
    try {
      const ctx = await startOutageServer();
      const { proxy, port, capture } = ctx;
      expect((await health(port)).status).toBe(200);
      proxy.blackhole();

      const answer = await health(port);
      await annotate(`blackhole, hung query: 503 after ${answer.elapsedMs} ms (query timeout 5000 ms)`);
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual(UNAVAILABLE_BODY);
      expect(answer.elapsedMs).toBeGreaterThanOrEqual(4500);
      expect(answer.elapsedMs).toBeLessThan(9000);
      expect(requestLines(capture.records()).at(-1)).toMatchObject({ level: 'error', status: 503, err: { code: 'QUERY_TIMEOUT', message: MESSAGE_BY_CODE.database_unavailable } });

      await expectRecovery(ctx, 'blackhole, hung query', annotate, crashes);
    } finally {
      crashes.stop();
    }
  }, 60_000);

  it('answers 503 for every request when all five pooled clients hang, the sixth with the pool timeout', async ({ annotate }) => {
    const crashes = watchForCrashes();
    try {
      const ctx = await startOutageServer();
      const { proxy, port, capture, instance } = ctx;
      const held = await Promise.all(Array.from({ length: 5 }, () => instance.pool.connect()));
      for (const client of held) client.release();
      proxy.blackhole();

      const answers = await Promise.all(Array.from({ length: 6 }, () => health(port)));
      const slowest = Math.max(...answers.map((answer) => answer.elapsedMs));
      await annotate(`blackhole, five hung clients plus a sixth request: six 503s, slowest ${slowest} ms, fastest ${Math.min(...answers.map((answer) => answer.elapsedMs))} ms`);
      for (const answer of answers) {
        expect(answer.status).toBe(503);
        expect(answer.body).toEqual(UNAVAILABLE_BODY);
      }
      expect(slowest).toBeLessThan(9000);
      await expect.poll(() => requestLines(capture.records()).filter((line) => line['status'] === 503).length).toBe(6);
      const codes = requestLines(capture.records()).map((line) => (line['err'] as { code: string }).code);
      expect(codes.sort()).toEqual(['POOL_TIMEOUT', 'QUERY_TIMEOUT', 'QUERY_TIMEOUT', 'QUERY_TIMEOUT', 'QUERY_TIMEOUT', 'QUERY_TIMEOUT']);

      await expectRecovery(ctx, 'blackhole, pool exhausted', annotate, crashes);
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

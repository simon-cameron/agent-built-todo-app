import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createPool } from '../src/db/pool';
import { buildTestConfig, silentLogger } from './db-setup';
import { captureLogger } from './log-capture';

const config = buildTestConfig();
const stubPool = (query: () => Promise<unknown>): pg.Pool => ({ query }) as unknown as pg.Pool;

describe('GET /health with the real test database', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool(config, silentLogger);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('returns 200 and exactly { status: ok }', async () => {
    const app = buildApp({ config, pool, logger: captureLogger().logger });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('writes no per-request log line', async () => {
    const capture = captureLogger();
    const app = buildApp({ config, pool, logger: capture.logger });
    await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    expect(capture.lines).toEqual([]);
  });

  it('answers HEAD', async () => {
    const app = buildApp({ config, pool, logger: captureLogger().logger });
    expect((await app.inject({ method: 'HEAD', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('does not answer an unknown route with 200', async () => {
    const app = buildApp({ config, pool, logger: captureLogger().logger });
    expect((await app.inject({ method: 'GET', url: '/nothing-here' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('the error handlers', () => {
  it('answers a client error on a matched route with a fixed 500, never its text', async () => {
    const marker = randomBytes(12).toString('hex');
    const capture = captureLogger();
    const app = buildApp({ config, pool: stubPool(async () => ({ rows: [] })), logger: capture.logger });
    app.get('/bad', async () => {
      throw Object.assign(new Error(`client mistake ${marker}`), { statusCode: 400 });
    });
    const response = await app.inject({ method: 'GET', url: '/bad' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error.' } });
    expect(response.body + capture.lines.join('\n')).not.toContain(marker);
    await app.close();
  });

  it('answers a malformed request line with 404 route_not_found', async () => {
    const app = buildApp({ config, pool: stubPool(async () => ({ rows: [] })), logger: captureLogger().logger });
    const response = await app.inject({ method: 'GET', url: '/health/%' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'route_not_found', message: 'No such route.' } });
    await app.close();
  });

  it('turns a database failure into a fixed 500 with no driver text in the body or the logs', async () => {
    const marker = randomBytes(12).toString('hex');
    const capture = captureLogger();
    const failing = stubPool(async () => {
      throw Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED', detail: marker, where: marker, query: marker });
    });
    const app = buildApp({ config, pool: failing, logger: capture.logger });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error.' } });
    expect(response.body + capture.lines.join('\n')).not.toContain(marker);
    expect(capture.records().find((record) => record.msg === 'request failed')).toMatchObject({ level: 'error', err: { code: 'ECONNREFUSED', message: 'connect failed' } });
    await app.close();
  });

  it('treats a 5xx status on an error as a fixed 500', async () => {
    const app = buildApp({ config, pool: stubPool(async () => ({ rows: [] })), logger: captureLogger().logger });
    app.get('/unavailable', async () => {
      throw Object.assign(new Error('x'), { statusCode: 503 });
    });
    const response = await app.inject({ method: 'GET', url: '/unavailable' });
    expect(response.statusCode).toBe(500);
    await app.close();
  });
});

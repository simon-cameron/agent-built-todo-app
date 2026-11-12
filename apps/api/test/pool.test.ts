import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool';
import { buildTestConfig } from './db-setup';
import { captureLogger } from './log-capture';

describe('createPool', () => {
  it('uses exactly the outage-safe values of the design (ADR Decision 11)', async () => {
    const pool = createPool(buildTestConfig(), captureLogger().logger);
    const { max, connectionTimeoutMillis, idleTimeoutMillis, keepAlive, statement_timeout, query_timeout } = pool.options;
    expect({ max, connectionTimeoutMillis, idleTimeoutMillis, keepAlive, statement_timeout, query_timeout }).toEqual({
      max: 5,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10_000,
      keepAlive: true,
      statement_timeout: 5000,
      query_timeout: 5000,
    });
    await pool.end();
  });

  it('has exactly one error listener, which logs a code and a fixed message and never the driver text', async () => {
    const secret = randomBytes(12).toString('hex');
    const capture = captureLogger();
    const pool = createPool(buildTestConfig(), capture.logger);
    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('error', Object.assign(new Error(`terminated ${secret}`), { code: 'ECONNRESET', detail: secret }));
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ level: 'error', msg: 'database pool error', err: { code: 'ECONNRESET', message: 'The database pool reported an error.' } });
    expect(capture.lines.join('\n')).not.toContain(secret);
    await pool.end();
  });
});

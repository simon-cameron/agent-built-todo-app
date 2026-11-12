import type pg from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createPool } from '../src/db/pool';
import { buildTestConfig, releaseTestLock, resetTodosTable, silentLogger, tryAcquireTestLock } from './db-setup';

let pool: pg.Pool | undefined;
let lockClient: pg.PoolClient | undefined;

beforeAll(async () => {
  pool = createPool(buildTestConfig(), silentLogger);
  lockClient = await pool.connect();
  if (!(await tryAcquireTestLock(lockClient))) {
    throw new Error('Another test file or another pnpm test run is using todo_test. Test files must run one at a time.');
  }
});

beforeEach(async () => {
  if (pool === undefined) throw new Error('The test pool was not created.');
  await resetTodosTable(pool);
});

afterAll(async () => {
  if (lockClient !== undefined) {
    await releaseTestLock(lockClient);
    lockClient.release();
  }
  await pool?.end();
});

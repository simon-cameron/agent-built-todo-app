import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool';
import {
  assertTestDatabase,
  describeDestructive,
  buildTestConfig,
  ensureTestDatabase,
  isDestructive,
  isTruncate,
  loadRootEnv,
  releaseTestLock,
  resetTodosTable,
  runInScratchDatabase,
  silentLogger,
  tryAcquireTestLock,
  type ClientLike,
  type Queryable,
  type Row,
} from './db-setup';

const generated = (): string => randomBytes(24).toString('hex');
const baseEnv = (): Record<string, string | undefined> => ({ DB_USER: 'app_user', DB_PASSWORD: generated() });

/** Records every statement and answers current_database() with the given name. */
function recordingStub(databaseName: string, existing: Row[] = []): { client: Queryable & { end(): Promise<void> }; statements: string[]; source: { connect(): Promise<ClientLike> } } {
  const statements: string[] = [];
  const query = async (text: string): Promise<{ rows: Row[] }> => {
    statements.push(text);
    if (/current_database/.test(text)) return { rows: [{ name: databaseName }] };
    if (/pg_database/.test(text)) return { rows: existing };
    return { rows: [] };
  };
  const client = { query, end: async () => undefined };
  return { client, statements, source: { connect: async () => ({ query, release: () => undefined }) } };
}

describe('buildTestConfig', () => {
  it.each([['todo'], ['prod_db'], [undefined]])('always uses todo_test, whatever DB_NAME is (%s)', (dbName) => {
    expect(buildTestConfig({ ...baseEnv(), DB_NAME: dbName }).dbName).toBe('todo_test');
  });

  it('fixes the API and web ports whatever the developer .env says', () => {
    const config = buildTestConfig({ ...baseEnv(), API_PORT: '4000', WEB_PORT: '4001' });
    expect([config.apiPort, config.webPort]).toEqual([3001, 3000]);
  });

  it('still applies the password rules and names the variable only', () => {
    const marker = randomBytes(4).toString('hex');
    expect(() => buildTestConfig({ DB_USER: 'app_user', DB_PASSWORD: marker })).toThrow(/DB_PASSWORD/);
    expect(() => buildTestConfig({ DB_USER: 'app_user', DB_PASSWORD: marker })).not.toThrow(new RegExp(marker));
  });
});

describe('assertTestDatabase', () => {
  it.each(['todo', 'postgres', '', 'test', 'todo_test_backup'])('throws for %j', (name) => {
    expect(() => assertTestDatabase(name)).toThrow();
  });
  it.each(['todo_test', 'x_test'])('accepts %s', (name) => {
    expect(() => assertTestDatabase(name)).not.toThrow();
  });
  it('throws for a value that is not a name', () => {
    expect(() => assertTestDatabase(undefined)).toThrow();
  });
});

describe('ensureTestDatabase', () => {
  it('creates only the literal todo_test, whatever the configured name is', async () => {
    const stub = recordingStub('postgres');
    process.env['DB_NAME'] = 'prod_db';
    try {
      await ensureTestDatabase(stub.client);
    } finally {
      delete process.env['DB_NAME'];
    }
    expect(stub.statements.filter(isDestructive).map(describeDestructive)).toEqual(['create todo_test']);
  });

  it('issues nothing destructive when the database already exists', async () => {
    const stub = recordingStub('postgres', [{ '?column?': 1 }]);
    await ensureTestDatabase(stub.client);
    expect(stub.statements.filter(isDestructive)).toEqual([]);
  });
});

describe('resetTodosTable', () => {
  it('refuses a database whose name does not end in _test and empties nothing', async () => {
    const stub = recordingStub('todo');
    await expect(resetTodosTable(stub.source)).rejects.toThrow(/_test/);
    expect(stub.statements.some(isTruncate)).toBe(false);
  });

  it('empties the table after the name check on a _test database', async () => {
    const stub = recordingStub('todo_test');
    await resetTodosTable(stub.source);
    expect(stub.statements.filter(isTruncate)).toHaveLength(1);
    expect(stub.statements.filter(isTruncate)[0]).toMatch(/RESTART IDENTITY$/);
  });
});

describe('runInScratchDatabase', () => {
  it('does not run the callback or drop anything afterwards when the connection reports another database', async () => {
    const maintenance = recordingStub('postgres');
    const scratch = recordingStub('todo');
    let ran = false;
    await expect(
      runInScratchDatabase({ maintenance: maintenance.client, openScratch: () => scratch.client }, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/_test|scratch/);
    expect(ran).toBe(false);
    expect(maintenance.statements.filter(isDestructive).map(describeDestructive)).toEqual(['drop todo_migrate_test', 'create todo_migrate_test']);
    expect([...maintenance.statements, ...scratch.statements].some(isTruncate)).toBe(false);
  });

  it('drops the scratch database after a passing run', async () => {
    const maintenance = recordingStub('postgres');
    const scratch = recordingStub('todo_migrate_test');
    await runInScratchDatabase({ maintenance: maintenance.client, openScratch: () => scratch.client }, async () => undefined);
    expect(maintenance.statements.filter(isDestructive).map(describeDestructive)).toEqual([
      'drop todo_migrate_test',
      'create todo_migrate_test',
      'drop todo_migrate_test',
    ]);
  });
});

describe('the real test database', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool(buildTestConfig(), silentLogger);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('is todo_test', async () => {
    expect((await pool.query('SELECT current_database() AS name')).rows[0]).toEqual({ name: 'todo_test' });
  });

  it('has DB_PASSWORD in the worker environment (the value is not shown)', () => {
    const value = process.env['DB_PASSWORD'];
    expect(typeof value === 'string' && value.length > 0).toBe(true);
  });

  it('starts the first test with data', async () => {
    await pool.query('INSERT INTO todos (title) VALUES ($1), ($2)', ['a', 'b']);
    expect((await pool.query('SELECT count(*)::int AS n FROM todos')).rows[0]).toEqual({ n: 2 });
  });

  it('starts the next test empty, with ids restarted', async () => {
    expect((await pool.query('SELECT count(*)::int AS n FROM todos')).rows[0]).toEqual({ n: 0 });
    expect((await pool.query('INSERT INTO todos (title) VALUES ($1) RETURNING id', ['c'])).rows[0]).toEqual({ id: 1 });
  });

  it('shows that this file holds the lock, so an overlapping file would fail', async () => {
    const other = await pool.connect();
    try {
      expect(await tryAcquireTestLock(other)).toBe(false);
    } finally {
      other.release();
    }
  });

  it('can take and release the lock once the holder lets go (own connection, then restored)', async () => {
    const separate = createPool(buildTestConfig(), silentLogger);
    const client = await separate.connect();
    try {
      expect(await tryAcquireTestLock(client)).toBe(false);
      await releaseTestLock(client);
    } finally {
      client.release();
      await separate.end();
    }
  });
});

describe('loadRootEnv', () => {
  it('tolerates a missing file', () => {
    expect(() => loadRootEnv(join(tmpdir(), `missing-${generated()}.env`))).not.toThrow();
  });

  it('adds new variables and never overrides existing ones', () => {
    const folder = mkdtempSync(join(tmpdir(), 'env-'));
    const fresh = `FRESH_${generated().slice(0, 8).toUpperCase()}`;
    const existing = `EXISTING_${generated().slice(0, 8).toUpperCase()}`;
    process.env[existing] = 'real';
    try {
      writeFileSync(join(folder, '.env'), `${fresh}=from-file\n${existing}=from-file\n`);
      loadRootEnv(join(folder, '.env'));
      expect(process.env[fresh]).toBe('from-file');
      expect(process.env[existing]).toBe('real');
    } finally {
      delete process.env[fresh];
      delete process.env[existing];
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

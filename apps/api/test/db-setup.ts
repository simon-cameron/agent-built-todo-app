import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadConfig, type AppConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { errorCode, type Logger } from '../src/logger';

/*
 * The only file in the repository allowed to issue TRUNCATE, DROP or CREATE DATABASE
 * (tooling/test/sql-safety.test.ts enforces that). It imports nothing from Vitest so Playwright can reuse it.
 * Destructive statements use literal names written in this module, never a config value.
 */

export const TEST_DATABASE = 'todo_test';
export const SCRATCH_DATABASE = 'todo_migrate_test';
const MAINTENANCE_DATABASE = 'postgres';
const TEST_API_PORT = '3001';
const TEST_WEB_PORT = '3000';
/** Session-level advisory lock key held by every test file while it runs. */
export const TEST_LOCK_KEY = 7_204_511;

export interface Row {
  readonly [column: string]: unknown;
}
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
export interface ClientLike extends Queryable {
  release(): void;
}
export interface ClientSource {
  connect(): Promise<ClientLike>;
}
export interface Closable {
  end(): Promise<void>;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const DESTRUCTIVE = /^\s*(TRUNCATE|DROP|CREATE\s+DATABASE)\b/i;
/** True for a statement the harness treats as destructive; used by tests that record SQL. */
export const isDestructive = (statement: string): boolean => DESTRUCTIVE.test(statement);
export const isTruncate = (statement: string): boolean => /^\s*TRUNCATE\b/i.test(statement);
/** A short form such as "drop todo_migrate_test", so tests can compare recorded statements without spelling them out. */
export function describeDestructive(statement: string): string {
  const words = statement.trim().split(/\s+/);
  return `${(words[0] ?? '').toLowerCase()} ${words.at(-1) ?? ''}`;
}
export const isDrop = (statement: string): boolean => /^\s*DROP\b/i.test(statement);

const rootEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');

/** Loads the repo-root .env into process.env without overriding real environment variables; a missing file is fine. */
export function loadRootEnv(path: string = rootEnvPath): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

/** The normal config rules apply, but the database name and the ports are forced so a developer .env cannot change a test. */
export function buildTestConfig(env: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  const result = loadConfig({ ...env, DB_NAME: TEST_DATABASE, API_PORT: TEST_API_PORT, WEB_PORT: TEST_WEB_PORT });
  if (!result.ok) {
    const names = result.problems.map((problem) => problem.variable).join(', ');
    throw new Error(`The test configuration is invalid (${names}). Create the root .env as the README describes.`);
  }
  return result.config;
}

export function assertTestDatabase(name: unknown): void {
  if (typeof name !== 'string' || !name.endsWith('_test')) {
    throw new Error('Refusing to continue: the connected database name does not end in _test.');
  }
}

/** Creates todo_test through the maintenance connection if it does not exist. */
export async function ensureTestDatabase(maintenance: Queryable): Promise<void> {
  const existing = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DATABASE]);
  if (existing.rows.length > 0) return;
  try {
    await maintenance.query('CREATE DATABASE todo_test');
  } catch (error) {
    if (errorCode(error) !== '42P04') throw error;
  }
}

/** Empties the todos table and restarts ids, after reading the database name on the same connection. */
export async function resetTodosTable(source: ClientSource): Promise<void> {
  const client = await source.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS name');
    assertTestDatabase(rows[0]?.['name']);
    await client.query('TRUNCATE todos RESTART IDENTITY');
  } finally {
    client.release();
  }
}

/** Tries to take the file-level lock; false means another test file or another test run holds it. */
export async function tryAcquireTestLock(client: Queryable): Promise<boolean> {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [TEST_LOCK_KEY]);
  return rows[0]?.['locked'] === true;
}

export async function releaseTestLock(client: Queryable): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1::bigint)', [TEST_LOCK_KEY]);
}

export interface ScratchDeps<S extends Queryable & Closable> {
  readonly maintenance: Queryable;
  readonly openScratch: () => S;
}

/**
 * Runs fn against a brand-new empty database (todo_migrate_test) so the migration test never touches todo_test.
 * The scratch connection must report the scratch name, which ends in _test, before fn runs. If it does not,
 * nothing is dropped afterwards.
 */
export async function runInScratchDatabase<S extends Queryable & Closable, T>(deps: ScratchDeps<S>, fn: (scratch: S) => Promise<T>): Promise<T> {
  await deps.maintenance.query('DROP DATABASE IF EXISTS todo_migrate_test');
  await deps.maintenance.query('CREATE DATABASE todo_migrate_test');
  const scratch = deps.openScratch();
  let guardPassed = false;
  try {
    const { rows } = await scratch.query('SELECT current_database() AS name');
    const name = rows[0]?.['name'];
    assertTestDatabase(name);
    if (name !== SCRATCH_DATABASE) throw new Error('Refusing to continue: the scratch connection is not on the scratch database.');
    guardPassed = true;
    return await fn(scratch);
  } finally {
    await scratch.end();
    if (guardPassed) await deps.maintenance.query('DROP DATABASE IF EXISTS todo_migrate_test');
  }
}

/** The real scratch database on the test server, for the migration test. */
export async function withScratchDatabase<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const config = buildTestConfig();
  const maintenance = createPool({ ...config, dbName: MAINTENANCE_DATABASE }, silentLogger);
  try {
    return await runInScratchDatabase({ maintenance, openScratch: () => createPool({ ...config, dbName: SCRATCH_DATABASE }, silentLogger) }, fn);
  } finally {
    await maintenance.end();
  }
}

/** Fails with a plain hint, never the driver error, when the database cannot be reached. */
export async function withDatabaseHint<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new Error(`The test database is not usable (error code ${errorCode(error)}). Start it with: docker compose up -d --wait`);
  }
}

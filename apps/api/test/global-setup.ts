import { createPool } from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { buildTestConfig, ensureTestDatabase, loadRootEnv, silentLogger, withDatabaseHint } from './db-setup';

/** Runs once before the workers start: loads the root .env, creates todo_test if absent and migrates it. */
export default async function setup(): Promise<void> {
  loadRootEnv();
  const config = buildTestConfig();
  await withDatabaseHint(async () => {
    const maintenance = createPool({ ...config, dbName: 'postgres' }, silentLogger);
    try {
      await ensureTestDatabase(maintenance);
    } finally {
      await maintenance.end();
    }
    const pool = createPool(config, silentLogger);
    try {
      await runMigrations(pool);
    } finally {
      await pool.end();
    }
  });
}

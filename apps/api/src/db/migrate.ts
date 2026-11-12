import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import * as schema from './schema';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies pending migrations from the committed folder; a second run applies nothing. */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  // The query logger is off because it would print SQL and parameters, which later hold todo titles.
  await migrate(drizzle(pool, { schema, logger: false }), { migrationsFolder: MIGRATIONS_FOLDER });
}

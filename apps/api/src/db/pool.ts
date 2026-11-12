import pg from 'pg';
import type { AppConfig } from '../config';
import { describeError, type Logger } from '../logger';

/**
 * Builds the pool from discrete fields (no connection string exists anywhere) with the
 * outage-safe settings from the design. The password is revealed here and nowhere else.
 */
export function createPool(config: AppConfig, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword.reveal(),
    database: config.dbName,
    max: 5,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10_000,
    keepAlive: true,
    statement_timeout: 5000,
    query_timeout: 5000,
  });
  // Without a listener, an idle client dropped when the database stops raises an unhandled 'error' and crashes Node.
  pool.on('error', (error) => logger.error({ err: describeError(error) }, 'database pool error'));
  return pool;
}

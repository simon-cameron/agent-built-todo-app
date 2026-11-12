import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp as defaultBuildApp } from './app';
import type { AppConfig } from './config';
import { runMigrations } from './db/migrate';
import { createPool } from './db/pool';
import { waitForDatabase } from './db/wait';
import { StartupError } from './errors';
import { describeError, errorCode } from './logger';

/** Code constant, never read from the environment or the config: the API is reachable from this machine only. */
export const LISTEN_HOST = '127.0.0.1';

export interface StartOptions {
  readonly config: AppConfig;
  readonly logger: FastifyBaseLogger;
  /** When given, it is used and also ended by stop() or by a failed start. */
  readonly pool?: pg.Pool;
  readonly probe?: (pool: pg.Pool) => Promise<void>;
  readonly buildApp?: typeof defaultBuildApp;
  readonly migrate?: (pool: pg.Pool) => Promise<void>;
  /** Total wait for the database, default 30 000 ms; a parameter, not an environment variable. */
  readonly waitMs?: number;
  /** Time between attempts, default 1000 ms. */
  readonly intervalMs?: number;
  /** Replaces the real delay so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RunningApp {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  /** Read back from the listening socket, not echoed from LISTEN_HOST. */
  readonly address: { readonly address: string; readonly port: number };
  /** Closes the app, then ends the pool. Safe to call more than once. */
  stop(): Promise<void>;
}

async function probeDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}

/** Builds the app, checks the database, migrates, then listens on 127.0.0.1. Nothing listens before the database is ready. */
export async function start(options: StartOptions): Promise<RunningApp> {
  const { config, logger } = options;
  const pool = options.pool ?? createPool(config, logger);
  const app = (options.buildApp ?? defaultBuildApp)({ config, pool, logger });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        await app.close();
      } finally {
        await pool.end();
      }
    })();
    return stopping;
  };

  try {
    const probe = options.probe ?? probeDatabase;
    await waitForDatabase({
      probe: () => probe(pool),
      target: { host: config.dbHost, port: config.dbPort, user: config.dbUser, database: config.dbName },
      logger,
      ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    const migrationStart = performance.now();
    await (options.migrate ?? runMigrations)(pool);
    logger.info({ durationMs: Math.round(performance.now() - migrationStart) }, 'migrations applied');

    try {
      await app.listen({ host: LISTEN_HOST, port: config.apiPort });
    } catch (error) {
      // Safe text only: the port number is ours and API_PORT is the variable that fixes it.
      if (errorCode(error) === 'EADDRINUSE') {
        throw new StartupError(`The API cannot start: port ${config.apiPort} is already in use. Stop the other program or change API_PORT in .env (see the README).`);
      }
      throw error;
    }
    const bound = app.server.address();
    if (bound === null || typeof bound === 'string') throw new Error('The server did not report a TCP address.');
    const address = { address: bound.address, port: bound.port };
    logger.info(address, 'listening');
    return { app, pool, address, stop };
  } catch (error) {
    await stop().catch((cleanupError: unknown) => logger.error({ err: describeError(cleanupError) }, 'cleanup after failed start failed'));
    throw error;
  }
}

export interface SignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface SignalDependencies {
  readonly signals: SignalSource;
  readonly exit: (code: number) => void;
  readonly logger: FastifyBaseLogger;
}

/** SIGINT and SIGTERM stop the app and the pool, then exit 0. A second signal gets Node's default behaviour. */
export function handleSignals(running: Pick<RunningApp, 'stop'>, { signals, exit, logger }: SignalDependencies): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    signals.once(signal, () => {
      logger.info({ signal }, 'shutting down');
      running.stop().then(
        () => exit(0),
        (error: unknown) => {
          logger.error({ err: describeError(error) }, 'shutdown failed');
          exit(1);
        },
      );
    });
  }
}

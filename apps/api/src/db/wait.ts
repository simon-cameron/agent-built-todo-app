import { StartupError } from '../errors';
import { errorCode, type Logger } from '../logger';

export const DEFAULT_WAIT_MS = 30_000;
export const DEFAULT_INTERVAL_MS = 1000;

export interface DatabaseTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
}

export interface WaitOptions {
  readonly probe: () => Promise<void>;
  readonly target: DatabaseTarget;
  readonly logger: Logger;
  readonly waitMs?: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function unreachableMessage({ host, port }: DatabaseTarget, attempts: number, waitMs: number): string {
  const duration = waitMs >= 1000 ? ` (about ${Math.round(waitMs / 1000)} seconds when the database refuses connections)` : '';
  return `The API cannot start: database unreachable at ${host}:${port} after ${attempts} attempts${duration}. Is it running? Start it with: docker compose up -d`;
}

/** Errors that retrying cannot fix. The messages name the user and database, never the password. */
function permanentFailure(code: string, { user, database }: DatabaseTarget): StartupError | undefined {
  if (code === '28P01') {
    return new StartupError(
      `The API cannot start: the database rejected the password for user "${user}". The password in .env does not match the one stored in the existing database volume, ` +
        'because Postgres applies POSTGRES_PASSWORD only when the volume is first created. ' +
        'Put the old DB_PASSWORD back to keep your data, or reset with "docker compose down -v" (this deletes all todos).',
    );
  }
  if (code.startsWith('28')) {
    return new StartupError(`The API cannot start: the database rejected the login for user "${user}". Check DB_USER and DB_PASSWORD in .env.`);
  }
  if (code === '3D000') {
    return new StartupError(
      `The API cannot start: the database "${database}" does not exist. Check DB_NAME in .env; Postgres creates that database only when the volume is first created.`,
    );
  }
  return undefined;
}

/**
 * Probes once per interval for floor(waitMs / intervalMs) + 1 attempts (31 by default). Refused connections return at once,
 * so that is about 30 seconds; a host that never answers can take longer because each attempt has its own timeout.
 * Authentication and missing-database errors stop at once; startup-in-progress (57P03) and connection errors retry.
 */
export async function waitForDatabase(options: WaitOptions): Promise<void> {
  const { probe, target, logger } = options;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = options.sleep ?? realSleep;
  const attempts = Math.floor(waitMs / intervalMs) + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await probe();
      return;
    } catch (error) {
      const code = errorCode(error);
      const permanent = permanentFailure(code, target);
      if (permanent !== undefined) throw permanent;
      // The code only: a driver message could carry connection details.
      logger.warn({ attempt, attempts, host: target.host, port: target.port, err: { code } }, 'database not reachable yet');
      if (attempt < attempts) await sleep(intervalMs);
    }
  }
  throw new StartupError(unreachableMessage(target, attempts, waitMs));
}

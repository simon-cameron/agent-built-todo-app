import { setTimeout as delay } from 'node:timers/promises';
import { afterEach } from 'vitest';
import { buildTestConfig } from './db-setup';
import { startDbProxy, type DbProxy } from './db-proxy';
import type { LogRecord } from './log-capture';
import { startTestServer, stopAllServers } from './serve';

/** The recovery limit of the design (ADR Decision 11, PRD): the next request succeeds within this long of the database returning. */
export const RECOVERY_LIMIT_MS = 30_000;

const proxies: DbProxy[] = [];

/** Call once at the top of an outage test file. Closes every proxy first, which destroys its sockets, and then stops the servers, so pool.end() cannot wait on a cut socket. */
export function outageTeardownAfterEach(): void {
  afterEach(async () => {
    await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
    await stopAllServers();
  });
}

/** The real app, listener and pool, with the database behind a test proxy. */
export async function startOutageServer() {
  const config = buildTestConfig();
  const proxy = await startDbProxy({ host: config.dbHost, port: config.dbPort });
  proxies.push(proxy);
  const server = await startTestServer(undefined, { dbPort: proxy.port });
  return { proxy, ...server };
}

export interface HealthAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly elapsedMs: number;
}

/** GET /health over a real socket. */
export async function health(port: number, query = ''): Promise<HealthAnswer> {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/health${query}`, { signal: AbortSignal.timeout(RECOVERY_LIMIT_MS) });
  return { status: response.status, body: await response.json(), elapsedMs: Math.round(performance.now() - started) };
}

/** Polls GET /health every 250 ms until it is 200, and fails after 30 seconds. Returns how long it took, from the call. */
export async function pollForRecovery(port: number): Promise<{ elapsedMs: number; attempts: number }> {
  const started = performance.now();
  for (let attempts = 1; ; attempts += 1) {
    try {
      if ((await health(port)).status === 200) return { elapsedMs: Math.round(performance.now() - started), attempts };
    } catch {
      // The next attempt decides.
    }
    if (performance.now() - started > RECOVERY_LIMIT_MS) throw new Error(`The API did not answer 200 within ${RECOVERY_LIMIT_MS} ms of the database returning.`);
    await delay(250);
  }
}

export const requestLines = (records: LogRecord[]): LogRecord[] => records.filter((record) => record.msg === 'request completed');
export const poolErrorLines = (records: LogRecord[]): LogRecord[] => records.filter((record) => record.msg === 'database pool error');

/** Collects uncaught exceptions and unhandled rejections while a test runs. */
export function watchForCrashes(): { seen: () => unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const record = (reason: unknown): void => void seen.push(reason);
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  return {
    seen: () => seen,
    stop: () => {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
    },
  };
}

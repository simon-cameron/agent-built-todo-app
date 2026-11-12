import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import { buildApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { start, type RunningApp } from '../src/start';
import { buildTestConfig } from './db-setup';
import { freePort } from './free-port';
import { captureLogger } from './log-capture';

const running: RunningApp[] = [];

/** Stops every server startTestServer started. */
export async function stopAllServers(): Promise<void> {
  await Promise.all(running.splice(0).map((instance) => instance.stop()));
}

/** Call once at the top of a test file that uses startTestServer: stops every server it started. */
export function stopServersAfterEach(): void {
  afterEach(stopAllServers);
}

/**
 * The real app on a real socket on a free port, with its logs captured. `extraRoutes` adds routes before it listens;
 * `configOverride` replaces config fields (for example `dbPort`, to put a proxy between the app and the database).
 */
export async function startTestServer(extraRoutes: (app: FastifyInstance) => void = () => undefined, configOverride: Partial<AppConfig> = {}) {
  const port = await freePort();
  const capture = captureLogger();
  const config = Object.assign({}, buildTestConfig(), { apiPort: port }, configOverride);
  const instance = await start({
    config,
    logger: capture.logger,
    buildApp: (dependencies) => {
      const app = buildApp(dependencies);
      extraRoutes(app);
      return app;
    },
  });
  running.push(instance);
  return { port, capture, instance };
}

import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import { buildApp } from '../src/app';
import { start, type RunningApp } from '../src/start';
import { buildTestConfig } from './db-setup';
import { freePort } from './free-port';
import { captureLogger } from './log-capture';

const running: RunningApp[] = [];

/** Call once at the top of a test file that uses startTestServer: stops every server it started. */
export function stopServersAfterEach(): void {
  afterEach(async () => {
    await Promise.all(running.splice(0).map((instance) => instance.stop()));
  });
}

/** The real app on a real socket on a free port, with its logs captured. `extraRoutes` adds routes before it listens. */
export async function startTestServer(extraRoutes: (app: FastifyInstance) => void = () => undefined) {
  const port = await freePort();
  const capture = captureLogger();
  const config = Object.assign({}, buildTestConfig(), { apiPort: port });
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

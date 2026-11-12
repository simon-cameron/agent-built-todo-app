import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppConfig } from './config';
import { replyWithError, sendError } from './errors';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly pool: pg.Pool;
  readonly logger: FastifyBaseLogger;
}

/**
 * Builds the app without opening a socket, so tests can use app.inject and tickets that add routes can reuse it.
 * The config is trusted, not re-validated.
 */
export function buildApp({ pool, logger }: AppDependencies): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // Same as the design's disableRequestLogging: true (the default request log includes headers); that top-level option is deprecated.
    logController: new LogController({ disableRequestLogging: true }),
    // Errors Fastify raises before routing (for example a bad URL) skip the error handler; both end in the same mapper.
    frameworkErrors: (error, request, reply) => {
      replyWithError(error, request, reply, logger);
    },
  });
  app.setErrorHandler((error, request, reply) => replyWithError(error, request, reply, app.log));
  app.setNotFoundHandler((_request, reply) => sendError(reply, 'route_not_found'));

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  return app;
}

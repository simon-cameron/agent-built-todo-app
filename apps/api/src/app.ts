import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppConfig } from './config';
import { replyWithError, sendError } from './errors';
import { logRequest, registerRequestLog } from './request-log';
import { FRAMEWORK_ERROR_HEADERS, registerSecurity } from './security';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly pool: pg.Pool;
  readonly logger: FastifyBaseLogger;
}

/**
 * Builds the app without opening a socket, so tests can use app.inject and tickets that add routes can reuse it.
 * The config is trusted, not re-validated.
 */
export function buildApp({ config, pool, logger }: AppDependencies): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // A client cannot choose the request id: the Fastify counter is the only source.
    requestIdHeader: false,
    // Host is read from the header itself, never from X-Forwarded-Host.
    trustProxy: false,
    // Same as the design's disableRequestLogging: true (the default request log includes headers); that top-level option is deprecated.
    logController: new LogController({ disableRequestLogging: true }),
    // Errors Fastify raises before routing (for example a bad URL) skip the error handler; both end in the same mapper.
    frameworkErrors: (error, request, reply) => {
      void reply.headers(FRAMEWORK_ERROR_HEADERS);
      replyWithError(error, request, reply);
      logRequest(logger, request, reply);
    },
  });
  app.setErrorHandler((error, request, reply) => replyWithError(error, request, reply));
  registerRequestLog(app, logger);
  registerSecurity(app, { apiPort: config.apiPort, webPort: config.webPort });
  app.setNotFoundHandler((_request, reply) => sendError(reply, 'route_not_found'));

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  return app;
}

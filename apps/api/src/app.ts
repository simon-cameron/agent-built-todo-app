import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import type pg from 'pg';
import type { AppConfig } from './config';
import { describeError } from './logger';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly pool: pg.Pool;
  readonly logger: FastifyBaseLogger;
}

const REQUEST_ERROR_BODY = { error: { code: 'request_error', message: 'Request could not be processed.' } } as const;
const INTERNAL_ERROR_BODY = { error: { code: 'internal_error', message: 'Internal server error.' } } as const;

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500 ? statusCode : undefined;
}

/**
 * Builds the app without opening a socket, so tests can use app.inject and tickets that add routes can reuse it.
 * The config is trusted, not re-validated.
 */
export function buildApp({ pool, logger }: AppDependencies): FastifyInstance {
  // Fixed bodies only: Fastify's default error body and log would carry a raw driver error.
  // The ticket that adds the error mapper replaces this and must add the stack trace on 5xx log lines.
  const reply = (error: unknown, response: FastifyReply, log: FastifyBaseLogger): FastifyReply => {
    const status = clientErrorStatus(error);
    if (status !== undefined) return response.status(status).send(REQUEST_ERROR_BODY);
    log.error({ err: describeError(error) }, 'request failed');
    return response.status(500).send(INTERNAL_ERROR_BODY);
  };

  const app = Fastify({
    loggerInstance: logger,
    // Same as the design's disableRequestLogging: true (the default request log includes headers); that top-level option is deprecated.
    logController: new LogController({ disableRequestLogging: true }),
    // Errors Fastify raises before routing (for example a bad URL) skip the error handler and need the same fixed bodies.
    frameworkErrors: (error, _request, response) => {
      reply(error, response, logger);
    },
  });
  app.setErrorHandler((error, _request, response) => reply(error, response, app.log));

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  return app;
}

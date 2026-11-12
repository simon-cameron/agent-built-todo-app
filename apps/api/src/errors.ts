import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorCode, ValidationDetail } from '@todo/shared';
import { describeError, errorCode } from './logger';
import { recordErrorInfo, type ErrorInfo } from './request-log';

/** A failure with a message that is safe to print as is; the process exits with code 1. */
export class StartupError extends Error {
  readonly exitCode = 1;
}

/** HTTP status of every contract code. Typed over the closed list, so a new code in @todo/shared fails the build until it has a status. */
export const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  validation_error: 400,
  invalid_filter: 400,
  invalid_id: 400,
  malformed_json: 400,
  host_not_allowed: 403,
  origin_not_allowed: 403,
  not_found: 404,
  route_not_found: 404,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
  database_unavailable: 503,
};

/** Default message of every contract code: fixed text, never built from request input. */
export const MESSAGE_BY_CODE: Readonly<Record<ErrorCode, string>> = {
  validation_error: 'The request body is not valid.',
  invalid_filter: 'filter must be one of all, active, done.',
  invalid_id: 'The id must be a whole number from 1 to 2147483647.',
  malformed_json: 'The request body is not valid JSON.',
  host_not_allowed: 'This host name is not allowed.',
  origin_not_allowed: 'This origin is not allowed.',
  not_found: 'That todo does not exist.',
  route_not_found: 'No such route.',
  payload_too_large: 'The request body is too large.',
  unsupported_media_type: 'Content-Type must be application/json.',
  internal_error: 'Internal server error.',
  database_unavailable: 'The database is not reachable. Try again shortly.',
};

/** The one response body shape of every error. `details` appears only with `validation_error`. */
export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: readonly ValidationDetail[];
  };
}

export interface ErrorOptions {
  /** Replaces the default message. Must be fixed text, never request input. */
  readonly message?: string;
  /** Allowed only with `validation_error`. */
  readonly details?: readonly ValidationDetail[];
}

/** An error a route or hook can throw to answer with a contract code. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly options: ErrorOptions;

  constructor(code: ErrorCode, options: ErrorOptions = {}) {
    super(options.message ?? MESSAGE_BY_CODE[code]);
    this.code = code;
    this.options = options;
  }
}

function buildBody(code: ErrorCode, options: ErrorOptions): ErrorBody {
  if (options.details !== undefined && code !== 'validation_error') {
    throw new TypeError('details are allowed only with validation_error.');
  }
  const message = options.message ?? MESSAGE_BY_CODE[code];
  return { error: options.details === undefined ? { code, message } : { code, message, details: options.details } };
}

/** What the log line records for a contract code answered on purpose: the code, plus the fixed message for a server error. */
function contractInfo(code: ErrorCode): ErrorInfo {
  return STATUS_BY_CODE[code] >= 500 ? { code, message: MESSAGE_BY_CODE.internal_error } : { code };
}

/** The only way a hook or handler writes an error response. Records what the request log may say about it. */
export function sendError(reply: FastifyReply, code: ErrorCode, options: ErrorOptions = {}): FastifyReply {
  const body = buildBody(code, options);
  recordErrorInfo(reply.request, contractInfo(code));
  return reply.code(STATUS_BY_CODE[code]).send(body);
}

/** How an error is answered, and what its log line may carry. */
export interface MappedError {
  readonly status: number;
  readonly code: ErrorCode;
  readonly options: ErrorOptions;
  readonly logged: ErrorInfo;
}

/** One mapping rule: returns a result when it applies, otherwise undefined so the next rule is tried. */
export type ErrorRule = (error: unknown, request: Pick<FastifyRequest, 'is404'>) => MappedError | undefined;

function mapped(code: ErrorCode, logged: ErrorInfo = contractInfo(code), options: ErrorOptions = {}): MappedError {
  return { status: STATUS_BY_CODE[code], code, options, logged };
}

function clientStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500 ? statusCode : undefined;
}

/**
 * Ordered rules, first match wins. Later tickets insert rules before the fallback instead of rewriting this list:
 * the database and timeout rules (503) and the parser rules (malformed_json, payload_too_large, unsupported_media_type).
 */
export const ERROR_RULES: readonly ErrorRule[] = [
  // An error thrown on purpose keeps its own contract code.
  (error) => (error instanceof AppError ? mapped(error.code, undefined, error.options) : undefined),
  // An unknown route wins over content type and parse errors (API contract, check order).
  (_error, request) => (request.is404 ? mapped('route_not_found') : undefined),
  // A malformed URL such as /health/% is raised before routing.
  (error) => (errorCode(error) === 'FST_ERR_BAD_URL' ? mapped('route_not_found') : undefined),
  // Any other client error has no contract code yet: answer 500 and log its code only, never its text.
  (error) => (clientStatus(error) === undefined ? undefined : mapped('internal_error', { code: errorCode(error) })),
  // Everything else: generic 500. The code is the runtime or driver code, the message is fixed.
  (error) => mapped('internal_error', { code: errorCode(error), message: MESSAGE_BY_CODE.internal_error }),
];

/** Maps any error to a contract code and a log-safe record. Never reads the error's message. */
export function mapError(error: unknown, request: Pick<FastifyRequest, 'is404'>): MappedError {
  for (const rule of ERROR_RULES) {
    const result = rule(error, request);
    if (result !== undefined) return result;
  }
  return mapped('internal_error', { code: errorCode(error), message: MESSAGE_BY_CODE.internal_error });
}

/**
 * Answers an error through the one envelope. Used by both Fastify error handlers.
 * The separate 'request failed' line for an unexpected error is S2's and stays until the request log writes one merged line per request.
 */
export function replyWithError(error: unknown, request: FastifyRequest, reply: FastifyReply, log: Pick<FastifyBaseLogger, 'error'>): FastifyReply {
  const result = mapError(error, request);
  recordErrorInfo(request, result.logged);
  if (result.logged.message !== undefined) log.error({ err: describeError(error) }, 'request failed');
  return reply.code(result.status).send(buildBody(result.code, result.options));
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorCode, ValidationDetail } from '@todo/shared';
import { classifyDatabaseFailure } from './db/failure';
import { errorCode, safeStack } from './logger';
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
  return STATUS_BY_CODE[code] >= 500 ? { code, message: MESSAGE_BY_CODE[code] } : { code };
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

/** Fastify's own codes for a body that is not valid JSON, or empty with a JSON content type. Matched by code, never by message, which quotes input. */
const MALFORMED_JSON_CODES: ReadonlySet<string> = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * Ordered rules, first match wins. Later tickets insert rules before the fallback instead of rewriting this list:
 * the parser rules payload_too_large and unsupported_media_type go before the interim client-error rule.
 */
export const ERROR_RULES: readonly ErrorRule[] = [
  // An error thrown on purpose keeps its own contract code.
  (error) => (error instanceof AppError ? mapped(error.code, undefined, error.options) : undefined),
  // An unknown route wins over content type and parse errors (API contract, check order).
  (_error, request) => (request.is404 ? mapped('route_not_found') : undefined),
  // A malformed URL such as /health/% is raised before routing.
  (error) => (errorCode(error) === 'FST_ERR_BAD_URL' ? mapped('route_not_found') : undefined),
  // A body that is not valid JSON. The log carries the contract code only.
  (error) => (MALFORMED_JSON_CODES.has(errorCode(error)) ? mapped('malformed_json') : undefined),
  // The database cannot be reached: a connection error or a pool or query timeout. The log carries a safe code and the fixed message.
  (error) => {
    const failure = classifyDatabaseFailure(error);
    return failure === undefined ? undefined : mapped('database_unavailable', { code: failure.code, message: MESSAGE_BY_CODE.database_unavailable });
  },
  // Any other client error has no contract code yet: answer 500 and log its code only, never its text.
  (error) => (clientStatus(error) === undefined ? undefined : mapped('internal_error', { code: errorCode(error) })),
  // Everything else: generic 500. The code is the runtime or driver code, the message is fixed.
  (error) => mapped('internal_error', { code: errorCode(error), message: MESSAGE_BY_CODE.internal_error }),
];

/** The record with the stack of the error added, when there is a clean one. */
function withStack(logged: ErrorInfo, error: unknown): ErrorInfo {
  const stack = safeStack(error);
  return stack === undefined ? logged : { ...logged, stack };
}

function applyRules(error: unknown, request: Pick<FastifyRequest, 'is404'>): MappedError {
  for (const rule of ERROR_RULES) {
    const result = rule(error, request);
    if (result !== undefined) return result;
  }
  return mapped('internal_error', { code: errorCode(error), message: MESSAGE_BY_CODE.internal_error });
}

/**
 * Maps any error to a contract code and a log-safe record. The record never contains the error's message or any other text of the error:
 * a code, the fixed message and, for a 5xx only, the stack as frame locations. Only the database rule reads the message,
 * to compare it with fixed driver texts (see db/failure.ts); it is never copied out.
 */
export function mapError(error: unknown, request: Pick<FastifyRequest, 'is404'>): MappedError {
  const result = applyRules(error, request);
  // The interim client-error rule logs its code alone until ticket 4 replaces it, so only records that carry the fixed message get a stack.
  return result.status >= 500 && result.logged.message !== undefined ? { ...result, logged: withStack(result.logged, error) } : result;
}

/** The body sent when mapping itself fails: constant text, so no thrown message can reach a response. */
const FALLBACK_BODY: ErrorBody = { error: { code: 'internal_error', message: MESSAGE_BY_CODE.internal_error } };

/** Last resort of replyWithError: a fixed 500, and if even that cannot be sent, the connection is dropped. */
function replyFallback(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  try {
    recordErrorInfo(request, { code: 'unknown', message: MESSAGE_BY_CODE.internal_error });
    return reply.code(500).send(FALLBACK_BODY);
  } catch {
    reply.raw.destroy();
    return reply;
  }
}

/**
 * Answers an error through the one envelope. Used by both Fastify error handlers; the request log writes the only line.
 * Total: if mapping or building the body throws, the fixed 500 goes out instead, because Fastify's own fallback would put the thrown message in the response.
 */
export function replyWithError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  try {
    const result = mapError(error, request);
    recordErrorInfo(request, result.logged);
    return reply.code(result.status).send(buildBody(result.code, result.options));
  } catch {
    return replyFallback(request, reply);
  }
}

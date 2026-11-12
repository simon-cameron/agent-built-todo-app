import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * What a request's log line may say about an error: a safe code and, for server errors, a fixed message.
 * `stack` is reserved for the ticket that adds stack traces to 5xx lines (ADR Decision 12); nothing sets it yet.
 */
export interface ErrorInfo {
  readonly code: string;
  readonly message?: string;
  readonly stack?: string;
}

const errorInfoByRequest = new WeakMap<object, ErrorInfo>();

/** Remembers the error info of a request; the first call wins so the original cause is not overwritten by a later handler. */
export function recordErrorInfo(request: FastifyRequest, info: ErrorInfo): void {
  if (!errorInfoByRequest.has(request)) errorInfoByRequest.set(request, info);
}

/** The error info recorded for this request, if any. */
export function errorInfoFor(request: FastifyRequest): ErrorInfo | undefined {
  return errorInfoByRequest.get(request);
}

/** A logged path is cut after this many code points, so a hostile request cannot write a very long line. */
export const MAX_LOGGED_PATH_CODE_POINTS = 200;
const ABSOLUTE_FORM_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;

/** The path of a raw request target: absolute-form prefix and query removed, then capped by code points so no character is split. */
export function loggedPath(target: string): string {
  const withoutPrefix = target.replace(ABSOLUTE_FORM_PREFIX, '');
  const end = withoutPrefix.search(/[?#]/);
  const path = end === -1 ? withoutPrefix : withoutPrefix.slice(0, end);
  const points = Array.from(path);
  return points.length <= MAX_LOGGED_PATH_CODE_POINTS ? path : points.slice(0, MAX_LOGGED_PATH_CODE_POINTS).join('');
}

export interface RequestLineInput {
  readonly method: string;
  /** The raw request target; the query is removed here. */
  readonly target: string;
  readonly status: number;
  readonly durationMs: number;
  readonly reqId: string;
  readonly err?: ErrorInfo | undefined;
}

export interface RequestLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: 'request completed';
  readonly fields: {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly durationMs: number;
    readonly reqId: string;
    readonly err?: ErrorInfo;
  };
}

/**
 * The one place a request line is built, so the response hook and the framework-error handler cannot drift apart.
 * info for 2xx and 3xx, warn for 4xx (error code only), error for 5xx (code, fixed message, stack when a later ticket records one).
 * Nothing from headers, bodies, the query or the raw error text can enter.
 */
export function buildRequestLine(input: RequestLineInput): RequestLine {
  const { method, target, status, durationMs, reqId, err } = input;
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  const base = { method, path: loggedPath(target), status, durationMs, reqId };
  if (err === undefined || status < 400) return { level, msg: 'request completed', fields: base };
  return { level, msg: 'request completed', fields: { ...base, err: status >= 500 ? err : { code: err.code } } };
}

/** Writes the line for a finished request. Always the root logger, never request.log, whose reqId binding would duplicate the field. */
export function logRequest(log: FastifyBaseLogger, request: FastifyRequest, reply: FastifyReply): void {
  const line = buildRequestLine({
    method: request.method,
    target: request.url,
    status: reply.statusCode,
    durationMs: Math.round(reply.elapsedTime * 10) / 10,
    reqId: String(request.id),
    err: errorInfoFor(request),
  });
  log[line.level](line.fields, line.msg);
}

/** One line per request that Fastify routes, written when the response is finished. */
export function registerRequestLog(app: FastifyInstance, log: FastifyBaseLogger): void {
  app.addHook('onResponse', async (request, reply) => {
    logRequest(log, request, reply);
  });
}

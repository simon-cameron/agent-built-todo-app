import type { FastifyRequest } from 'fastify';

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

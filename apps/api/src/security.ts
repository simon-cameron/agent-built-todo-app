import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sendError } from './errors';

/** Ports the allowlists derive from. There is no other input: nothing here reads an environment variable. */
export interface SecurityPorts {
  readonly apiPort: number;
  readonly webPort: number;
}

/** The two Host values a request to the API may carry. */
export function allowedHosts(apiPort: number): readonly string[] {
  return [`localhost:${apiPort}`, `127.0.0.1:${apiPort}`];
}

/** The two Origin values a browser page may send. Exact and case-sensitive, as browsers write them. */
export function allowedOrigins(webPort: number): readonly string[] {
  return [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`];
}

/** Lowercases ASCII letters only, so no locale or Unicode folding can turn a different name into an allowed one. */
function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/**
 * True when the Host header is exactly `localhost` or `127.0.0.1` followed by the API port, ignoring ASCII case.
 * A missing, empty, comma-joined or otherwise different value fails. This stops DNS rebinding.
 *
 * @param header - The raw Host header value, or undefined when absent.
 * @param apiPort - The port the API listens on.
 */
export function checkHost(header: string | undefined, apiPort: number): boolean {
  return header !== undefined && allowedHosts(apiPort).includes(asciiLowercase(header));
}

/**
 * True when there is no Origin header, or it is exactly one of the two local web origins.
 * A missing Origin passes on purpose: non-browser clients (curl, scripts) never send one, and the Host check
 * already blocks DNS rebinding. An empty value counts as present and fails.
 *
 * @param header - The raw Origin header value, or undefined when absent.
 * @param webPort - The port the web app is served on.
 */
export function checkOrigin(header: string | undefined, webPort: number): boolean {
  return header === undefined || allowedOrigins(webPort).includes(header);
}

/** How many Host header lines the request carried; Node keeps only the first one in request.headers. */
function hostLineCount(request: FastifyRequest): number {
  const raw = request.raw.rawHeaders;
  let count = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (asciiLowercase(raw[index] ?? '') === 'host') count += 1;
  }
  return count;
}

/** Host rules on a request: one Host line, an origin-form target (starts with /), and an allowed value. Never reads X-Forwarded-Host. */
function hostIsAllowed(request: FastifyRequest, apiPort: number): boolean {
  if (hostLineCount(request) > 1) return false;
  if (!request.raw.url?.startsWith('/')) return false;
  return checkHost(request.headers.host, apiPort);
}

/** Answers 403 host_not_allowed for a bad Host. Runs on every request Fastify routes, including unknown routes and preflight. */
export const hostPlugin = fp<SecurityPorts>(
  async (app, { apiPort }) => {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!hostIsAllowed(request, apiPort)) return sendError(reply, 'host_not_allowed');
      return undefined;
    });
  },
  { name: 'todo-host-check' },
);

/** Answers 403 origin_not_allowed for a bad Origin, before CORS can short-circuit a preflight. */
export const originPlugin = fp<SecurityPorts>(
  async (app, { webPort }) => {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!checkOrigin(request.headers.origin, webPort)) return sendError(reply, 'origin_not_allowed');
      return undefined;
    });
  },
  { name: 'todo-origin-check' },
);

/**
 * Registers the browser-safety hooks in a fixed order (Host, then Origin). Each is a skip-override plugin, so the
 * registration order is the execution order and the hooks also apply to the not-found handler.
 */
export function registerSecurity(app: FastifyInstance, ports: SecurityPorts): void {
  void app.register(hostPlugin, ports);
  void app.register(originPlugin, ports);
}

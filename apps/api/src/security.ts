import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
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

/** The content-security policy of every response: the API serves JSON only, so nothing may load and nothing may frame it. */
export const CONTENT_SECURITY_POLICY = "default-src 'none';frame-ancestors 'none'";

/**
 * The security headers for the one answer no hook can reach: Fastify raises a malformed URL such as /health/% before
 * routing, so the helmet and no-store hooks never run for it. Kept equal to what a normal response carries by a test
 * that compares both ways, so a helmet upgrade that adds or changes a header fails the build instead of drifting.
 */
export const FRAMEWORK_ERROR_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
};

/** Methods a browser may use cross-origin. */
export const CORS_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
/** Seconds a browser may cache a preflight answer. */
export const CORS_MAX_AGE_SECONDS = 600;

/** Adds `Cache-Control: no-store` to every response, including the ones a later hook rejects. */
export const noStorePlugin = fp(
  async (app) => {
    app.addHook('onRequest', async (_request: FastifyRequest, reply: FastifyReply) => {
      void reply.header('cache-control', 'no-store');
    });
  },
  { name: 'todo-no-store' },
);

/**
 * Answers 404 route_not_found to an OPTIONS request that is not a real preflight (no Origin or no
 * Access-Control-Request-Method), so the CORS plugin's plain-text 400 never appears.
 */
export const optionsPlugin = fp(
  async (app) => {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.method !== 'OPTIONS') return undefined;
      if (request.headers.origin !== undefined && request.headers['access-control-request-method'] !== undefined) return undefined;
      return sendError(reply, 'route_not_found');
    });
  },
  { name: 'todo-options-guard' },
);

/**
 * Registers the browser-safety layer in a fixed order: security headers, `no-store`, Host, Origin, the plain
 * OPTIONS guard, then CORS. Each is a skip-override plugin, so the registration order is the execution order,
 * the hooks also apply to the not-found handler, and a 403 carries the headers while CORS never runs for it.
 */
export function registerSecurity(app: FastifyInstance, ports: SecurityPorts): void {
  void app.register(helmet, {
    // Only the two directives below: no merged default such as 'unsafe-inline'.
    contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
  });
  void app.register(noStorePlugin);
  void app.register(hostPlugin, ports);
  void app.register(originPlugin, ports);
  void app.register(optionsPlugin);
  void app.register(cors, {
    // The exact two origins, never * and never reflected from the request.
    origin: [...allowedOrigins(ports.webPort)],
    methods: [...CORS_METHODS],
    allowedHeaders: ['Content-Type'],
    maxAge: CORS_MAX_AGE_SECONDS,
    credentials: false,
  });
}

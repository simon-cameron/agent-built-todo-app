import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { CONTENT_SECURITY_POLICY, FRAMEWORK_ERROR_HEADERS } from '../src/security';
import { buildTestConfig } from './db-setup';
import { captureLogger } from './log-capture';
import { injectLocal, rawRequest, rawSocket } from './request';
import { startTestServer, stopServersAfterEach } from './serve';

stopServersAfterEach();

const config = buildTestConfig();
const WEB = config.webPort;
const ALLOWED_ORIGINS = [`http://localhost:${WEB}`, `http://127.0.0.1:${WEB}`];
const quietPool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const failingPool = {
  query: async () => {
    throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
  },
} as unknown as pg.Pool;

function appFor(pool: pg.Pool = quietPool) {
  const capture = captureLogger();
  return { app: buildApp({ config, pool, logger: capture.logger }), capture };
}

const preflightHeaders = (origin: string): Record<string, string> => ({ origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' });

describe('cross-origin access', () => {
  it.each(ALLOWED_ORIGINS)('grants exactly %s to a request from it, with Vary: Origin and no credentials header', async (origin) => {
    const { app } = appFor();
    const response = await injectLocal(app, { method: 'GET', url: '/health', headers: { origin } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(String(response.headers['vary'])).toMatch(/\bOrigin\b/i);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });

  it('grants nothing to a request with no Origin, and never sends a wildcard', async () => {
    const { app } = appFor();
    const response = await injectLocal(app, { method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it.each(['http://evil.example', 'null', 'http://localhost:3001', 'HTTP://localhost:3000'])('grants nothing to Origin %s (it is rejected with 403)', async (origin) => {
    const { app } = appFor();
    for (const request of [
      { method: 'GET', url: '/health', headers: { origin } },
      { method: 'OPTIONS', url: '/health', headers: preflightHeaders(origin) },
    ] as const) {
      const response = await injectLocal(app, request);
      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-methods']).toBeUndefined();
    }
    await app.close();
  });
});

describe('preflight', () => {
  it.each(ALLOWED_ORIGINS)('answers 204 to a preflight from %s with the method list, Content-Type and max-age 600', async (origin) => {
    const { app } = appFor();
    const response = await injectLocal(app, { method: 'OPTIONS', url: '/health', headers: preflightHeaders(origin) });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, PATCH, PUT, DELETE');
    expect(response.headers['access-control-allow-headers']).toBe('Content-Type');
    expect(response.headers['access-control-max-age']).toBe('600');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.body).toBe('');
    await app.close();
  });

  it('also answers 204 for a path that does not exist (a todo route added later needs no change)', async () => {
    const { app } = appFor();
    const response = await injectLocal(app, { method: 'OPTIONS', url: '/v1/anything', headers: preflightHeaders(ALLOWED_ORIGINS[0] as string) });
    expect(response.statusCode).toBe(204);
    await app.close();
  });

  it('answers a bad-Host preflight with 403, not 204: Host runs before CORS', async () => {
    const { app } = appFor();
    const response = await app.inject({ method: 'OPTIONS', url: '/health', headers: { ...preflightHeaders(ALLOWED_ORIGINS[0] as string), host: 'evil.example:3001' } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('answers a bad-Origin preflight with 403, not 204: Origin runs before CORS', async () => {
    const { app } = appFor();
    const response = await injectLocal(app, { method: 'OPTIONS', url: '/health', headers: preflightHeaders('http://evil.example') });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('a plain OPTIONS request', () => {
  const plain = [
    { name: 'no Origin', headers: {} },
    { name: 'Origin without Access-Control-Request-Method', headers: { origin: ALLOWED_ORIGINS[0] as string } },
    { name: 'Access-Control-Request-Method without Origin', headers: { 'access-control-request-method': 'GET' } },
  ];

  it.each(plain)('gets 404 route_not_found, not the CORS plugin plain-text 400 ($name)', async ({ headers }) => {
    const { app } = appFor();
    for (const url of ['/health', '/nope']) {
      const response = await injectLocal(app, { method: 'OPTIONS', url, headers });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual({ error: { code: 'route_not_found', message: 'No such route.' } });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    }
    await app.close();
  });

  it('writes exactly one log line', async () => {
    const { app, capture } = appFor();
    await injectLocal(app, { method: 'OPTIONS', url: '/health' });
    await app.close();
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ level: 'warn', method: 'OPTIONS', status: 404, err: { code: 'route_not_found' } });
  });
});

describe('security headers', () => {
  const responses: [string, () => Promise<{ headers: Record<string, unknown>; status: number }>][] = [
    [
      '200',
      async () => {
        const { app } = appFor();
        const response = await injectLocal(app, { method: 'GET', url: '/health' });
        await app.close();
        return { headers: response.headers, status: response.statusCode };
      },
    ],
    [
      '404',
      async () => {
        const { app } = appFor();
        const response = await injectLocal(app, { method: 'GET', url: '/nope' });
        await app.close();
        return { headers: response.headers, status: response.statusCode };
      },
    ],
    [
      '403 from Host',
      async () => {
        const { app } = appFor();
        const response = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example:3001' } });
        await app.close();
        return { headers: response.headers, status: response.statusCode };
      },
    ],
    [
      '403 from Origin',
      async () => {
        const { app } = appFor();
        const response = await injectLocal(app, { method: 'GET', url: '/health', headers: { origin: 'http://evil.example' } });
        await app.close();
        return { headers: response.headers, status: response.statusCode };
      },
    ],
    [
      '500',
      async () => {
        const { app } = appFor(failingPool);
        const response = await injectLocal(app, { method: 'GET', url: '/health' });
        await app.close();
        return { headers: response.headers, status: response.statusCode };
      },
    ],
    [
      '204 preflight',
      async () => {
        const { app } = appFor();
        const response = await injectLocal(app, { method: 'OPTIONS', url: '/health', headers: preflightHeaders(ALLOWED_ORIGINS[0] as string) });
        await app.close();
        return { headers: response.headers, status: response.statusCode };
      },
    ],
    [
      'malformed URL /health/%',
      async () => {
        const { app } = appFor();
        const response = await injectLocal(app, { method: 'GET', url: '/health/%' });
        await app.close();
        return { headers: response.headers, status: response.statusCode };
      },
    ],
  ];

  it.each(responses)('are on every response: %s', async (_name, send) => {
    const { headers } = await send();
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-frame-options']).toBeDefined();
  });

  it('has a content-security policy of exactly two directives, with no unsafe-inline or merged default', async () => {
    const { app } = appFor();
    const response = await injectLocal(app, { method: 'GET', url: '/health' });
    const policy = String(response.headers['content-security-policy']);
    // Helmet writes the directives joined by ";" with no space.
    expect(policy).toBe("default-src 'none';frame-ancestors 'none'");
    expect(policy.split(';').map((directive) => directive.trim()).sort()).toEqual(["default-src 'none'", "frame-ancestors 'none'"]);
    expect(policy).not.toContain('unsafe-inline');
    await app.close();
  });

  it('keeps helmet defaults other than the policy, including the one-year HSTS header (ADR: helmet defaults)', async () => {
    const { app } = appFor();
    const response = await injectLocal(app, { method: 'GET', url: '/health' });
    expect(response.headers['strict-transport-security']).toMatch(/^max-age=\d+/);
    await app.close();
  });
});

describe('the headers of the malformed-URL answer', () => {
  const NOT_SECURITY = new Set(['content-type', 'content-length', 'date', 'connection', 'keep-alive', 'vary']);

  it('equal the security headers of a normal response, in both directions', async () => {
    const { app } = appFor();
    const normal = await injectLocal(app, { method: 'GET', url: '/health' });
    const bad = await injectLocal(app, { method: 'GET', url: '/health/%' });
    await app.close();
    const securityHeaders = Object.fromEntries(Object.entries(normal.headers).filter(([name]) => !NOT_SECURITY.has(name) && !name.startsWith('access-control-')));
    expect(FRAMEWORK_ERROR_HEADERS).toEqual(securityHeaders);
    for (const [name, value] of Object.entries(FRAMEWORK_ERROR_HEADERS)) expect(bad.headers[name], name).toBe(value);
  });
});

describe('over a real socket', () => {
  it('serves the happy path with cross-origin and security headers and exactly one log line', async () => {
    const { port, capture } = await startTestServer();
    const response = await rawRequest({ port, path: '/health', headers: { origin: ALLOWED_ORIGINS[0] as string } });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGINS[0]);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capture.records().filter((record) => record.msg === 'request completed')).toHaveLength(1);
  });

  it('answers a real preflight to an allowed origin with 204', async () => {
    const { port } = await startTestServer();
    const response = await rawRequest({ port, method: 'OPTIONS', path: '/v1/todos', headers: preflightHeaders(ALLOWED_ORIGINS[1] as string) });
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGINS[1]);
  });

  it('puts the headers on the malformed-URL answer too', async () => {
    const { port } = await startTestServer();
    const reply = await rawSocket(port, `GET /health/% HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(reply.toLowerCase()).toContain('cache-control: no-store');
    expect(reply.toLowerCase()).toContain(`content-security-policy: ${CONTENT_SECURITY_POLICY}`);
  });
});

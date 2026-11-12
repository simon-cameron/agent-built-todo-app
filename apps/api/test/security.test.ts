import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { allowedHosts, allowedOrigins, checkHost, checkOrigin } from '../src/security';
import { buildTestConfig } from './db-setup';
import { captureLogger } from './log-capture';
import { bodyOf, injectLocal, localHost, rawRequest, rawSocket, statusOf } from './request';
import { startTestServer, stopServersAfterEach } from './serve';

stopServersAfterEach();

const config = buildTestConfig();
const API = config.apiPort;
const WEB = config.webPort;
const quietPool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const HOST_DENIED = { error: { code: 'host_not_allowed', message: 'This host name is not allowed.' } };
const ORIGIN_DENIED = { error: { code: 'origin_not_allowed', message: 'This origin is not allowed.' } };

function appWithRoutes() {
  const capture = captureLogger();
  const app = buildApp({ config, pool: quietPool, logger: capture.logger });
  app.get('/probe', async () => ({ reached: true }));
  return { app, capture };
}

describe('checkHost', () => {
  it('derives the allowlist from the API port only', () => {
    expect(allowedHosts(3001)).toEqual(['localhost:3001', '127.0.0.1:3001']);
    expect(allowedHosts(4000)).toEqual(['localhost:4000', '127.0.0.1:4000']);
  });

  it.each(['localhost:3001', '127.0.0.1:3001', 'LOCALHOST:3001', 'LocalHost:3001'])('accepts %s', (host) => {
    expect(checkHost(host, 3001)).toBe(true);
  });

  it.each([
    ['a foreign name', 'evil.example:3001'],
    ['no port', 'localhost'],
    ['no port on the address', '127.0.0.1'],
    ['empty', ''],
    ['wrong port', 'localhost:3002'],
    ['leading zero in the port', 'localhost:03001'],
    ['trailing dot on the name', 'localhost.:3001'],
    ['trailing dot after the port', 'localhost:3001.'],
    ['IPv6 loopback', '[::1]:3001'],
    ['IPv4-mapped IPv6', '[::ffff:127.0.0.1]:3001'],
    ['any-address', '0.0.0.0:3001'],
    ['short IPv4', '127.1:3001'],
    ['decimal IPv4', '2130706433:3001'],
    ['userinfo', 'user@localhost:3001'],
    ['trailing space', 'localhost:3001 '],
    ['trailing tab', 'localhost:3001\t'],
    ['leading space', ' localhost:3001'],
    ['two values in one header', 'localhost:3001, evil.example'],
    ['allowed name with a foreign suffix', 'localhost:3001.evil.example'],
    ['a Kelvin sign that lowercases to k', 'localhost:3001K'],
    ['a dotless I', 'ıocalhost:3001'],
  ])('rejects %s', (_name, host) => {
    expect(checkHost(host, 3001)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(checkHost(undefined, 3001)).toBe(false);
  });
});

describe('checkOrigin', () => {
  it('derives the allowlist from the web port only', () => {
    expect(allowedOrigins(3000)).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000'])('accepts %s', (origin) => {
    expect(checkOrigin(origin, 3000)).toBe(true);
  });

  it('accepts a request with no Origin, because curl and scripts never send one and the Host check covers DNS rebinding', () => {
    expect(checkOrigin(undefined, 3000)).toBe(true);
  });

  it.each([
    ['the string null', 'null'],
    ['a foreign origin', 'http://evil.example'],
    ['an upper-case scheme', 'HTTP://localhost:3000'],
    ['an upper-case host', 'http://LOCALHOST:3000'],
    ['a trailing slash', 'http://localhost:3000/'],
    ['https', 'https://localhost:3000'],
    ['the API port', 'http://localhost:3001'],
    ['no port', 'http://localhost'],
    ['an empty value', ''],
    ['two values', 'http://localhost:3000, http://127.0.0.1:3000'],
    ['an allowed name with a foreign suffix', 'http://localhost:3000.evil.example'],
    ['a path', 'http://localhost:3000/x'],
  ])('rejects %s', (_name, origin) => {
    expect(checkOrigin(origin, 3000)).toBe(false);
  });
});

describe('the Host hook (app.inject)', () => {
  const badHosts = ['evil.example:3001', 'localhost', 'localhost:3002', 'localhost.:3001', '[::1]:3001', '127.0.0.1', 'localhost:03001', '0.0.0.0:3001', '127.1:3001', '2130706433:3001', '[::ffff:127.0.0.1]:3001', 'user@localhost:3001', 'localhost:3001.', 'localhost:3001, evil.example'];
  const targets = [
    { method: 'GET', url: '/health' },
    { method: 'GET', url: '/no-such-route' },
    { method: 'OPTIONS', url: '/health' },
    { method: 'OPTIONS', url: '/no-such-route', headers: { origin: `http://localhost:${WEB}`, 'access-control-request-method': 'GET' } },
    { method: 'POST', url: '/health' },
  ] as const;

  it.each(badHosts)('answers 403 host_not_allowed for Host %s, on every kind of target', async (host) => {
    const { app } = appWithRoutes();
    for (const target of targets) {
      const response = await app.inject({ ...target, headers: { ...('headers' in target ? target.headers : {}), host } });
      expect(response.statusCode, `${host} ${target.method} ${target.url}`).toBe(403);
      expect(response.json(), `${host} ${target.method} ${target.url}`).toEqual(HOST_DENIED);
    }
    await app.close();
  });

  it('accepts LOCALHOST:3001 case-insensitively, and both allowed names', async () => {
    const { app } = appWithRoutes();
    for (const host of [`LOCALHOST:${API}`, `localhost:${API}`, `127.0.0.1:${API}`]) {
      expect((await app.inject({ method: 'GET', url: '/probe', headers: { host } })).statusCode, host).toBe(200);
    }
    await app.close();
  });

  it('gives a bad Host on an unknown route 403, not 404', async () => {
    const { app } = appWithRoutes();
    const response = await app.inject({ method: 'GET', url: '/no-such-route', headers: { host: 'evil.example:3001' } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('does not reach the route, and a 403 carries no cross-origin grant', async () => {
    const { app } = appWithRoutes();
    const response = await app.inject({ method: 'GET', url: '/probe', headers: { host: 'evil.example:3001', origin: `http://localhost:${WEB}` } });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('reached');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('ignores X-Forwarded-Host, in both directions', async () => {
    const { app } = appWithRoutes();
    const forgedGood = await app.inject({ method: 'GET', url: '/probe', headers: { host: 'evil.example:3001', 'x-forwarded-host': localHost() } });
    expect(forgedGood.statusCode).toBe(403);
    const forgedBad = await app.inject({ method: 'GET', url: '/probe', headers: { host: localHost(), 'x-forwarded-host': 'evil.example' } });
    expect(forgedBad.statusCode).toBe(200);
    await app.close();
  });
});

describe('the Origin hook (app.inject)', () => {
  const badOrigins = ['null', 'http://evil.example', 'HTTP://localhost:3000', 'http://localhost:3000/', 'https://localhost:3000', 'http://localhost:3001', 'http://localhost', '', 'http://localhost:3000, http://127.0.0.1:3000'];

  it.each(badOrigins)('answers 403 origin_not_allowed for Origin "%s", on every kind of target', async (origin) => {
    const { app } = appWithRoutes();
    const targets = [
      { method: 'GET', url: '/health', headers: {} },
      { method: 'GET', url: '/no-such-route', headers: {} },
      { method: 'OPTIONS', url: '/health', headers: {} },
      { method: 'OPTIONS', url: '/no-such-route', headers: { 'access-control-request-method': 'GET' } },
    ] as const;
    for (const target of targets) {
      const response = await injectLocal(app, { method: target.method, url: target.url, headers: { ...target.headers, origin } });
      expect(response.statusCode, `${target.method} ${target.url}`).toBe(403);
      expect(response.json(), `${target.method} ${target.url}`).toEqual(ORIGIN_DENIED);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    await app.close();
  });

  it('accepts both allowed origins, and a request without any Origin (curl, scripts)', async () => {
    const { app } = appWithRoutes();
    for (const headers of [{ origin: `http://localhost:${WEB}` }, { origin: `http://127.0.0.1:${WEB}` }, {}]) {
      expect((await injectLocal(app, { method: 'GET', url: '/probe', headers })).statusCode, JSON.stringify(headers)).toBe(200);
    }
    await app.close();
  });

  it('checks Host before Origin: both bad gives host_not_allowed', async () => {
    const { app } = appWithRoutes();
    const response = await app.inject({ method: 'GET', url: '/probe', headers: { host: 'evil.example:3001', origin: 'http://evil.example' } });
    expect(response.json()).toEqual(HOST_DENIED);
    await app.close();
  });

  it('answers a preflight with a bad Host 403, not 204 or 404', async () => {
    const { app } = appWithRoutes();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: { host: 'evil.example:3001', origin: `http://localhost:${WEB}`, 'access-control-request-method': 'POST' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('the checks over a real socket', () => {
  it('serves the happy path: Host 127.0.0.1 and Origin http://localhost:3000, one log line', async () => {
    const { port, capture } = await startTestServer();
    const response = await rawRequest({ port, path: '/health', headers: { origin: `http://localhost:${WEB}` } });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capture.records().filter((record) => record.msg === 'request completed')).toHaveLength(1);
  });

  it('logs a 403 as one warn line with the code only, and never the Host or Origin value', async () => {
    const { port, capture } = await startTestServer();
    const hostMarker = `${randomBytes(8).toString('hex')}.example`;
    const originMarker = `http://${randomBytes(8).toString('hex')}.example`;
    await rawRequest({ port, path: '/health', headers: { host: hostMarker } });
    await rawRequest({ port, path: '/health', headers: { origin: originMarker } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const lines = capture.records().filter((record) => record.msg === 'request completed');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line['err'])).toEqual([{ code: 'host_not_allowed' }, { code: 'origin_not_allowed' }]);
    expect(lines.every((line) => line.level === 'warn' && line['status'] === 403)).toBe(true);
    expect(capture.lines.join('\n')).not.toContain(hostMarker);
    expect(capture.lines.join('\n')).not.toContain(originMarker.slice('http://'.length));
  });

  it('rejects two separate Host lines (the duplicate-line form, as opposed to one comma-joined value)', async () => {
    const { port } = await startTestServer();
    const reply = await rawSocket(port, `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
    expect(statusOf(reply)).toBe(403);
    expect(bodyOf(reply)).toEqual(HOST_DENIED);
  });

  it('rejects two Origin lines (Node joins them with a comma)', async () => {
    const { port } = await startTestServer();
    const reply = await rawSocket(port, `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://localhost:${WEB}\r\nOrigin: http://localhost:${WEB}\r\nConnection: close\r\n\r\n`);
    expect(statusOf(reply)).toBe(403);
    expect(bodyOf(reply)).toEqual(ORIGIN_DENIED);
  });

  it('rejects an absolute-form request target with a good Host', async () => {
    const { port } = await startTestServer();
    const reply = await rawSocket(port, `GET http://evil.example/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(statusOf(reply)).toBe(403);
    expect(bodyOf(reply)).toEqual(HOST_DENIED);
  });

  it('rejects a Host with no port, an empty Host, a lone [::1] and a Host with a foreign name', async () => {
    const { port } = await startTestServer();
    for (const host of ['127.0.0.1', '', `[::1]:${port}`, `evil.example:${port}`, `localhost:${port + 1}`]) {
      const reply = await rawSocket(port, `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      expect(statusOf(reply), `Host "${host}"`).toBe(403);
    }
  });

  it('treats a Host with trailing spaces as the allowed host, because Node trims outer whitespace before the check sees it', async () => {
    const { port } = await startTestServer();
    for (const trailing of [' ', '\t']) {
      const reply = await rawSocket(port, `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}${trailing}\r\nConnection: close\r\n\r\n`);
      expect(statusOf(reply), JSON.stringify(trailing)).toBe(200);
    }
  });

  it('rejects an HTTP/1.0 request with no Host', async () => {
    const { port } = await startTestServer();
    const reply = await rawSocket(port, 'GET /health HTTP/1.0\r\n\r\n');
    expect(statusOf(reply)).toBe(403);
    expect(bodyOf(reply)).toEqual(HOST_DENIED);
  });

  it('pins Node itself rejecting an HTTP/1.1 request with no Host: a bare 400 before any hook runs (accepted residual)', async () => {
    const { port, capture } = await startTestServer();
    const reply = await rawSocket(port, 'GET /health HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect(statusOf(reply)).toBe(400);
    expect(bodyOf(reply)).toBeUndefined();
    expect(capture.records().filter((record) => record.msg === 'request completed')).toHaveLength(0);
  });

  it('pins the malformed-URL path skipping the Host check: a bad Host on /health/% still gets the constant 404', async () => {
    const { port } = await startTestServer();
    const reply = await rawSocket(port, 'GET /health/% HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    expect(statusOf(reply)).toBe(404);
    expect(bodyOf(reply)).toEqual({ error: { code: 'route_not_found', message: 'No such route.' } });
  });
});

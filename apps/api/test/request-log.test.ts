import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { buildRequestLine, loggedPath, MAX_LOGGED_PATH_CODE_POINTS } from '../src/request-log';
import { buildTestConfig } from './db-setup';
import { captureLogger, type LogRecord } from './log-capture';
import { injectLocal, rawRequest, type RawRequestOptions } from './request';
import { startTestServer, stopServersAfterEach } from './serve';

const marker = (): string => randomBytes(12).toString('hex');
const requestLines = (records: LogRecord[]): LogRecord[] => records.filter((record) => record.msg === 'request completed');

stopServersAfterEach();

/** The real app on a real socket, with routes that fail in the ways the tests need. */
function serve() {
  return startTestServer((app) => {
    app.get('/boom', async () => {
      throw Object.assign(new Error('boom'), { code: 'XX000' });
    });
    app.get('/client-error', async () => {
      throw Object.assign(new Error('client mistake'), { statusCode: 400, code: 'FST_ERR_VALIDATION' });
    });
  });
}

/** Sends one request, waits for its line, then waits a moment more so a second line would be seen. */
async function lineFor(port: number, capture: ReturnType<typeof captureLogger>, options: Omit<RawRequestOptions, 'port'>) {
  const before = requestLines(capture.records()).length;
  const response = await rawRequest({ port, ...options });
  await expect.poll(() => requestLines(capture.records()).length, { timeout: 2000 }).toBeGreaterThan(before);
  await delay(40);
  const added = requestLines(capture.records()).slice(before);
  expect(added).toHaveLength(1);
  return { response, line: added[0] as LogRecord };
}

describe('exactly one line per request over a real socket', () => {
  const cases: { name: string; options: Omit<RawRequestOptions, 'port'>; status: number; level: string }[] = [
    { name: '200', options: { path: '/health' }, status: 200, level: 'info' },
    { name: 'unknown route 404', options: { path: '/nothing' }, status: 404, level: 'warn' },
    { name: 'unknown method 404', options: { method: 'DELETE', path: '/health' }, status: 404, level: 'warn' },
    { name: 'plain OPTIONS 404', options: { method: 'OPTIONS', path: '/health' }, status: 404, level: 'warn' },
    { name: 'bad JSON to an unknown route', options: { method: 'POST', path: '/nothing', headers: { 'content-type': 'application/json' }, body: '{"a":' }, status: 404, level: 'warn' },
    { name: 'client-status error on a matched route', options: { path: '/client-error' }, status: 500, level: 'error' },
    { name: '500', options: { path: '/boom' }, status: 500, level: 'error' },
    { name: 'malformed URL', options: { path: '/health/%' }, status: 404, level: 'warn' },
  ];

  it.each(cases)('$name', async ({ options, status, level }) => {
    const { port, capture } = await serve();
    const { response, line } = await lineFor(port, capture, options);
    expect(response.status).toBe(status);
    expect(line).toMatchObject({ level, msg: 'request completed', status, method: options.method ?? 'GET' });
  });

  it('has exactly the documented fields on a 200 line', async () => {
    const { port, capture } = await serve();
    const { line } = await lineFor(port, capture, { path: '/health' });
    expect(Object.keys(line).sort()).toEqual(['durationMs', 'level', 'method', 'msg', 'path', 'reqId', 'status', 'time']);
    expect(line).toMatchObject({ path: '/health', status: 200, level: 'info' });
    expect(typeof line['durationMs']).toBe('number');
    expect(typeof line['reqId']).toBe('string');
    expect(Number.isNaN(Date.parse(String(line['time'])))).toBe(false);
  });
});

describe('what an error line carries', () => {
  it('has a warn 4xx line with the contract code and nothing else under err', async () => {
    const { port, capture } = await serve();
    const { line } = await lineFor(port, capture, { path: '/nothing' });
    expect(line).toMatchObject({ level: 'warn', err: { code: 'route_not_found' } });
    expect(line['err']).toEqual({ code: 'route_not_found' });
  });

  it('has an error 5xx line with the runtime code and the fixed message, never the thrown text', async () => {
    const { port, capture } = await serve();
    const { line } = await lineFor(port, capture, { path: '/boom' });
    expect(line['err']).toEqual({ code: 'XX000', message: 'Internal server error.' });
  });

  it('names the code of a client-status error on a matched route and no message', async () => {
    const { port, capture } = await serve();
    const { line } = await lineFor(port, capture, { path: '/client-error' });
    expect(line['err']).toEqual({ code: 'FST_ERR_VALIDATION' });
  });

  it('writes the malformed-URL line through the same builder as every other line', async () => {
    const { port, capture } = await serve();
    const { line } = await lineFor(port, capture, { path: '/health/%' });
    expect(Object.keys(line).sort()).toEqual(['durationMs', 'err', 'level', 'method', 'msg', 'path', 'reqId', 'status', 'time']);
    expect(line).toMatchObject({ path: '/health/%', status: 404, err: { code: 'route_not_found' } });
  });
});

describe('what a line never carries', () => {
  it('leaves out the query, and every marker from query, header, body and thrown message', async () => {
    const { port, capture } = await serve();
    const secrets = { query: marker(), header: marker(), body: marker(), origin: marker(), thrown: marker() };
    await lineFor(port, capture, { path: `/health?marker=${secrets.query}`, headers: { 'x-marker': secrets.header } });
    await lineFor(port, capture, { method: 'POST', path: '/nothing', headers: { 'content-type': 'application/json' }, body: `{"title":"${secrets.body}` });
    await lineFor(port, capture, { path: `/boom?${secrets.thrown}`, headers: { origin: `http://localhost:3000/${secrets.origin}` } });
    const all = capture.lines.join('\n');
    for (const [name, value] of Object.entries(secrets)) expect(all, name).not.toContain(value);
    expect(all).not.toContain('marker=');
    expect(requestLines(capture.records()).map((line) => line['path'])).toEqual(['/health', '/nothing', '/boom']);
  });

  it('does not take the request id from a header', async () => {
    const { port, capture } = await serve();
    const secret = marker();
    const { line } = await lineFor(port, capture, { path: '/health', headers: { 'request-id': secret, 'x-request-id': secret } });
    expect(String(line['reqId'])).not.toContain(secret);
    expect(capture.lines.join('\n')).not.toContain(secret);
  });
});

describe('the path in a line', () => {
  it('is capped at 200 code points on a real request', async () => {
    const { port, capture } = await serve();
    const { line } = await lineFor(port, capture, { path: `/${'a'.repeat(299)}` });
    expect(String(line['path'])).toHaveLength(MAX_LOGGED_PATH_CODE_POINTS);
  });

  it('is cut by code point, so a surrogate pair at the cut is kept whole or left out whole', () => {
    const atCut = `/${'x'.repeat(198)}\u{1F600}zzz`;
    const kept = loggedPath(atCut);
    expect(Array.from(kept)).toHaveLength(200);
    expect(kept.endsWith('\u{1F600}')).toBe(true);
    const beforeCut = loggedPath(`/${'x'.repeat(199)}\u{1F600}zzz`);
    expect(Array.from(beforeCut)).toHaveLength(200);
    expect(beforeCut.isWellFormed()).toBe(true);
    expect(beforeCut.endsWith('x')).toBe(true);
  });

  it('drops the query, the fragment and an absolute-form prefix', () => {
    expect(loggedPath('/health?a=1')).toBe('/health');
    expect(loggedPath('/health#frag')).toBe('/health');
    expect(loggedPath('http://evil.example:80/health?x=1')).toBe('/health');
    expect(loggedPath('/short')).toBe('/short');
  });
});

describe('buildRequestLine', () => {
  const base = { method: 'GET', target: '/x?y=1', durationMs: 1.5, reqId: 'req-1' };

  it('maps status to level', () => {
    expect(buildRequestLine({ ...base, status: 200 }).level).toBe('info');
    expect(buildRequestLine({ ...base, status: 302 }).level).toBe('info');
    expect(buildRequestLine({ ...base, status: 404 }).level).toBe('warn');
    expect(buildRequestLine({ ...base, status: 503 }).level).toBe('error');
  });

  it('keeps err.code only for 4xx even if more was recorded, and the whole record for 5xx', () => {
    const info = { code: 'x_code', message: 'fixed', stack: 'at somewhere' };
    expect(buildRequestLine({ ...base, status: 400, err: info }).fields.err).toEqual({ code: 'x_code' });
    expect(buildRequestLine({ ...base, status: 500, err: info }).fields.err).toEqual(info);
    expect(buildRequestLine({ ...base, status: 200, err: info }).fields.err).toBeUndefined();
  });
});

describe('the request line under app.inject', () => {
  it('is written once for a request that fails inside the route', async () => {
    const capture = captureLogger();
    const app = buildApp({ config: buildTestConfig(), pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool, logger: capture.logger });
    await injectLocal(app, { method: 'GET', url: '/nothing' });
    await app.close();
    expect(requestLines(capture.records())).toHaveLength(1);
  });
});

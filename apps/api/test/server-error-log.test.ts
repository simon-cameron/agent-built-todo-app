import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { AppError, MESSAGE_BY_CODE, replyWithError } from '../src/errors';
import { errorInfoFor } from '../src/request-log';
import { buildTestConfig } from './db-setup';
import { captureLogger, type LogRecord } from './log-capture';
import { injectLocal, localHost } from './request';

const config = buildTestConfig();
const quietPool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const marker = (): string => randomBytes(12).toString('hex');
const FRAME = /^ {4}at (?:node:|file:\/\/)?[A-Za-z0-9_\-./\\@+~%]+:\d+:\d+$/;

/** An error shaped like a pg server error, with the marker in every field the driver can fill. */
function pgError(code: string, secret: string, message = `server said ${secret}`): Error {
  return Object.assign(new Error(message), {
    code,
    severity: 'ERROR',
    detail: secret,
    where: secret,
    hint: secret,
    query: secret,
    parameters: [secret],
    schema: secret,
    table: secret,
    column: secret,
    constraint: secret,
    position: '1',
  });
}

/** The app with a route that throws what the test gives it, the way a real handler would. */
function appThrowing(make: () => unknown) {
  const capture = captureLogger();
  const app = buildApp({ config, pool: quietPool, logger: capture.logger });
  app.get('/throws', async () => {
    throw make();
  });
  return { app, capture };
}

const requestLine = (records: LogRecord[]): LogRecord => records.find((record) => record.msg === 'request completed') as LogRecord;

function expectFramesOnly(stack: unknown): void {
  expect(typeof stack).toBe('string');
  const lines = String(stack).split('\n');
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.length).toBeLessThanOrEqual(6);
  expect(String(stack).length).toBeLessThanOrEqual(1500);
  for (const line of lines) expect(line).toMatch(FRAME);
}

describe('a synthetic database error whose every field carries a marker', () => {
  const cases = [
    { code: '23505', status: 500, body: { code: 'internal_error', message: MESSAGE_BY_CODE.internal_error } },
    { code: '42P01', status: 500, body: { code: 'internal_error', message: MESSAGE_BY_CODE.internal_error } },
    { code: '57P01', status: 503, body: { code: 'database_unavailable', message: MESSAGE_BY_CODE.database_unavailable } },
  ] as const;

  it.each(cases)('$code answers $status with the contract body, and the marker is in no response and no log line', async ({ code, status, body }) => {
    const secret = marker();
    const { app, capture } = appThrowing(() => pgError(code, secret));
    const response = await injectLocal(app, { method: 'GET', url: '/throws' });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: body });
    expect(response.body).not.toContain(secret);
    expect(capture.lines.join('\n')).not.toContain(secret);
    expect(capture.lines).toHaveLength(1);
    const line = requestLine(capture.records());
    expect(line).toMatchObject({ level: 'error', status, err: { code, message: body.message } });
    expect(Object.keys(line['err'] as object).sort()).toEqual(['code', 'message', 'stack']);
    expectFramesOnly((line['err'] as { stack: unknown }).stack);
    await app.close();
  });

  it.each([
    ['in a multi-line message that fakes a frame line', (secret: string) => pgError('XX000', secret, `first ${secret}\n    at /fake/frame.ts:1:1)\nlast ${secret}`)],
    ['in a name set on the prototype', (secret: string) => Object.assign(pgError('XX000', secret), { name: `Named ${secret}` })],
    ['in a message that is also a title-shaped driver text', (secret: string) => pgError('XX000', secret, `Query read timeout ${secret}`)],
  ])('keeps the marker out when it is %s', async (_label, make) => {
    const secret = marker();
    const { app, capture } = appThrowing(() => make(secret));
    const response = await injectLocal(app, { method: 'GET', url: '/throws' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: MESSAGE_BY_CODE.internal_error } });
    expect(response.body + capture.lines.join('\n')).not.toContain(secret);
    expect(response.body + capture.lines.join('\n')).not.toContain('/fake/frame.ts');
    expect(capture.lines).toHaveLength(1);
    await app.close();
  });

  it('keeps connection details out of the error line, whatever the driver message says', async () => {
    const secret = marker();
    const { app, capture } = appThrowing(() => Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:5435 ${secret}`), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 5435 }));
    const response = await injectLocal(app, { method: 'GET', url: '/throws' });
    expect(response.statusCode).toBe(503);
    const all = response.body + capture.lines.join('\n');
    for (const forbidden of ['127.0.0.1:5435', 'ECONNREFUSED 127.', secret, '"address"']) expect(all).not.toContain(forbidden);
    expect(requestLine(capture.records())).toMatchObject({ level: 'error', err: { code: 'ECONNREFUSED' } });
    await app.close();
  });

  it('writes one line for a failing request: Fastify\'s own error log stays off', async () => {
    const { app, capture } = appThrowing(() => new Error('plain failure'));
    await injectLocal(app, { method: 'GET', url: '/throws' });
    await app.close();
    expect(capture.lines).toHaveLength(1);
    expect(requestLine(capture.records()).msg).toBe('request completed');
  });

  it('never puts a stack on a response', async () => {
    const { app } = appThrowing(() => new Error('plain failure'));
    const response = await injectLocal(app, { method: 'GET', url: '/throws' });
    expect(Object.keys(response.json<{ error: object }>().error).sort()).toEqual(['code', 'message']);
    expect(response.body).not.toMatch(/\bat\s.+:\d+/);
    await app.close();
  });
});

describe('the one envelope', () => {
  it('has exactly { error: { code, message } } for 403, 404, 500 and 503, whichever path wrote it', async () => {
    const { app } = appThrowing(() => new Error('x'));
    app.get('/down', async () => {
      throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    });
    app.get('/gone', async () => {
      throw new AppError('not_found');
    });
    const requests = [
      { options: { url: '/health', headers: { host: 'evil.example' } }, status: 403, code: 'host_not_allowed' },
      { options: { url: '/health', headers: { origin: 'http://evil.example' } }, status: 403, code: 'origin_not_allowed' },
      { options: { url: '/nothing-here' }, status: 404, code: 'route_not_found' },
      { options: { url: '/gone' }, status: 404, code: 'not_found' },
      { options: { url: '/throws' }, status: 500, code: 'internal_error' },
      { options: { url: '/down' }, status: 503, code: 'database_unavailable' },
    ] as const;
    for (const { options, status, code } of requests) {
      const response = await injectLocal(app, { method: 'GET', ...options });
      expect(response.statusCode, code).toBe(status);
      expect(response.json(), code).toEqual({ error: { code, message: MESSAGE_BY_CODE[code] } });
      expect(Object.keys(response.json<{ error: object }>().error), code).toEqual(['code', 'message']);
    }
    await app.close();
  });

  it('gives byte-identical bodies for a code written by a hook and the same code thrown by a handler', async () => {
    const { app } = appThrowing(() => new Error('x'));
    app.get('/thrown-host', async () => {
      throw new AppError('host_not_allowed');
    });
    app.get('/thrown-origin', async () => {
      throw new AppError('origin_not_allowed');
    });
    app.get('/thrown-missing', async () => {
      throw new AppError('route_not_found');
    });
    const pairs = [
      [await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example' } }), await injectLocal(app, { method: 'GET', url: '/thrown-host' })],
      [await injectLocal(app, { method: 'GET', url: '/health', headers: { origin: 'http://evil.example' } }), await injectLocal(app, { method: 'GET', url: '/thrown-origin' })],
      [await injectLocal(app, { method: 'GET', url: '/nothing-here' }), await injectLocal(app, { method: 'GET', url: '/thrown-missing' })],
    ] as const;
    for (const [fromHook, fromHandler] of pairs) {
      expect(fromHandler.body).toBe(fromHook.body);
      expect(fromHandler.statusCode).toBe(fromHook.statusCode);
    }
    await app.close();
  });
});

describe('replyWithError when mapping itself fails', () => {
  const failingRequest = (): FastifyRequest =>
    ({
      get is404(): boolean {
        throw new Error('is404 getter');
      },
    }) as unknown as FastifyRequest;

  function fakeReply(sendFails: boolean) {
    const sent: { status?: number; body?: unknown; destroyed: boolean } = { destroyed: false };
    const reply = {
      code(status: number) {
        sent.status = status;
        return reply;
      },
      send(body: unknown) {
        if (sendFails) throw new Error('send failed');
        sent.body = body;
        return reply;
      },
      raw: {
        destroy() {
          sent.destroyed = true;
        },
      },
    };
    return { reply: reply as unknown as FastifyReply, sent };
  }

  it('sends the fixed 500 body and records a fixed log message, never the thrown text', () => {
    const request = failingRequest();
    const { reply, sent } = fakeReply(false);
    replyWithError(new Error('db text'), request, reply);
    expect(sent).toEqual({ status: 500, body: { error: { code: 'internal_error', message: MESSAGE_BY_CODE.internal_error } }, destroyed: false });
    expect(errorInfoFor(request)).toEqual({ code: 'unknown', message: MESSAGE_BY_CODE.internal_error });
  });

  it('drops the connection when even the fixed body cannot be sent', () => {
    const { reply, sent } = fakeReply(true);
    replyWithError(new Error('db text'), failingRequest(), reply);
    expect(sent.destroyed).toBe(true);
  });

  it('answers a real request whose error handler cannot build a body with the fixed 500', async () => {
    const secret = marker();
    const { app, capture } = appThrowing(() => new AppError('not_found', { details: [{ field: secret, reason: 'empty' }] }));
    const response = await app.inject({ method: 'GET', url: '/throws', headers: { host: localHost() } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: MESSAGE_BY_CODE.internal_error } });
    expect(response.body + capture.lines.join('\n')).not.toContain(secret);
    await app.close();
  });
});

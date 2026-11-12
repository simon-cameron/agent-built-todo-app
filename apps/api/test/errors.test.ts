import { randomBytes } from 'node:crypto';
import { errorCodes } from 'fastify';
import { ERROR_CODES } from '@todo/shared';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { AppError, ERROR_RULES, MESSAGE_BY_CODE, STATUS_BY_CODE, mapError, sendError } from '../src/errors';
import { buildTestConfig } from './db-setup';
import { captureLogger } from './log-capture';
import { injectLocal } from './request';

const config = buildTestConfig();
const quietPool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const marker = (): string => randomBytes(12).toString('hex');
const clientError = (text: string, code = 'FST_ERR_VALIDATION'): Error => Object.assign(new Error(text), { statusCode: 400, code });

/** The body the reply would carry for a mapped error. */
function buildBodyOf(result: ReturnType<typeof mapError>): unknown {
  return { error: { code: result.code, message: result.options.message ?? MESSAGE_BY_CODE[result.code] } };
}

function appWith(capture = captureLogger()) {
  return { app: buildApp({ config, pool: quietPool, logger: capture.logger }), capture };
}

describe('the code tables', () => {
  it('give every contract code a status and a message, and nothing else', () => {
    expect(Object.keys(STATUS_BY_CODE).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(MESSAGE_BY_CODE).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(STATUS_BY_CODE[code], code).toBeGreaterThanOrEqual(400);
      expect(MESSAGE_BY_CODE[code].length, code).toBeGreaterThan(0);
    }
  });

  it('match the API contract status matrix', () => {
    expect(STATUS_BY_CODE).toEqual({
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
    });
  });
});

describe('the not-found handler and the bad-URL path', () => {
  it('answers an unknown path and an unknown method with 404 route_not_found and the same body', async () => {
    const { app } = appWith();
    const expected = { error: { code: 'route_not_found', message: 'No such route.' } };
    for (const request of [
      { method: 'GET', url: '/nothing-here' },
      { method: 'POST', url: '/health' },
      { method: 'DELETE', url: '/health' },
      { method: 'GET', url: '/health/%' },
    ] as const) {
      const response = await injectLocal(app, request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
      expect(response.json(), `${request.method} ${request.url}`).toEqual(expected);
    }
    await app.close();
  });
});

describe('errors on a request that matched no route', () => {
  it('answers bad JSON with 404 route_not_found and shows the marker nowhere', async () => {
    const secret = marker();
    const { app, capture } = appWith();
    const response = await injectLocal(app, { method: 'POST', url: '/nothing-here', headers: { 'content-type': 'application/json' }, payload: `{"title": "${secret}` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'route_not_found', message: 'No such route.' } });
    expect(response.body + capture.lines.join('\n')).not.toContain(secret);
    await app.close();
  });

  it('answers an oversized body with 404 route_not_found and shows the marker nowhere', async () => {
    const secret = marker();
    const { app, capture } = appWith();
    const response = await injectLocal(app, { method: 'POST', url: '/nothing-here', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ title: secret.repeat(100_000) }) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'route_not_found', message: 'No such route.' } });
    expect(response.body + capture.lines.join('\n')).not.toContain(secret);
    await app.close();
  });
});

describe('errors on a matched route', () => {
  it('answers a client-status framework error with a generic 500 and no text from the error', async () => {
    const secret = marker();
    const { app, capture } = appWith();
    app.get('/bad', async () => {
      throw clientError(`Unexpected token ${secret}`);
    });
    const response = await injectLocal(app, { method: 'GET', url: '/bad' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error.' } });
    expect(response.body + capture.lines.join('\n')).not.toContain(secret);
    await app.close();
  });

  it('answers an unexpected error with a generic 500 and no text from the error', async () => {
    const secret = marker();
    const { app } = appWith();
    app.get('/boom', async () => {
      throw new Error(`boom ${secret}`);
    });
    const response = await injectLocal(app, { method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error.' } });
    expect(response.body).not.toContain(secret);
    await app.close();
  });

  it('keeps the contract code of a thrown AppError and its fixed message', async () => {
    const { app } = appWith();
    app.get('/gone', async () => {
      throw new AppError('not_found');
    });
    app.get('/invalid', async () => {
      throw new AppError('validation_error', { details: [{ field: 'title', reason: 'empty' }] });
    });
    const gone = await injectLocal(app, { method: 'GET', url: '/gone' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: { code: 'not_found', message: MESSAGE_BY_CODE.not_found } });
    const invalid = await injectLocal(app, { method: 'GET', url: '/invalid' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: { code: 'validation_error', message: MESSAGE_BY_CODE.validation_error, details: [{ field: 'title', reason: 'empty' }] } });
    await app.close();
  });

  it('allows details only with validation_error', async () => {
    const { app } = appWith();
    app.get('/misuse', async (_request, reply) => sendError(reply, 'not_found', { details: [{ field: 'title', reason: 'empty' }] }));
    expect((await injectLocal(app, { method: 'GET', url: '/misuse' })).statusCode).toBe(500);
    await app.close();
  });
});

describe('mapError', () => {
  const live = { is404: false };

  it('tries the unknown-route rule before the client-error rule, so an unknown route is never a 500', () => {
    expect(mapError(clientError('x'), { is404: true })).toMatchObject({ status: 404, code: 'route_not_found' });
    expect(mapError(clientError('x'), live)).toMatchObject({ status: 500, code: 'internal_error' });
  });

  it('ends the list with a rule that always matches, so later tickets insert rules before it', () => {
    expect(ERROR_RULES.length).toBeGreaterThanOrEqual(5);
    const last = ERROR_RULES.at(-1);
    expect(last?.(null, live)).toMatchObject({ status: 500, code: 'internal_error' });
    expect(last?.(undefined, live)).toMatchObject({ status: 500 });
  });

  it('maps a bad URL to 404 route_not_found whatever its status', () => {
    expect(mapError(Object.assign(new Error('x'), { code: 'FST_ERR_BAD_URL', statusCode: 400 }), live)).toMatchObject({ status: 404, code: 'route_not_found' });
  });

  it('survives values that are not errors', () => {
    for (const value of [null, undefined, 'text', 42, {}, { statusCode: 'x' }]) {
      expect(mapError(value, live), String(value)).toMatchObject({ status: 500, code: 'internal_error' });
    }
  });

  it('pins which code a log line carries: the driver or runtime code for 5xx, the contract code for 4xx', () => {
    const driver = mapError(Object.assign(new Error('failed'), { code: 'XX000' }), live);
    expect(driver.logged).toMatchObject({ code: 'XX000', message: MESSAGE_BY_CODE.internal_error });
    const outage = mapError(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }), live);
    expect(outage.logged).toMatchObject({ code: 'ECONNREFUSED', message: MESSAGE_BY_CODE.database_unavailable });
    const contract = mapError(new AppError('not_found'), live);
    expect(contract.logged).toEqual({ code: 'not_found' });
    expect(mapError(clientError('x'), { is404: true }).logged).toEqual({ code: 'route_not_found' });
  });

  it('logs a client-status error by its code only, with no message', () => {
    expect(mapError(clientError('quoted input', 'FST_ERR_CTP_BODY_TOO_LARGE'), live).logged).toEqual({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
  });

  it('never puts the error message into the logged record', () => {
    const secret = marker();
    for (const error of [new Error(secret), clientError(secret), Object.assign(new Error(secret), { code: 'XX000', detail: secret })]) {
      expect(JSON.stringify(mapError(error, live).logged)).not.toContain(secret);
    }
  });

  it('maps both Fastify body-parse errors to 400 malformed_json with the fixed message and the contract code only in the log', () => {
    const secret = marker();
    for (const make of [() => new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY(), () => new errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY()]) {
      const result = mapError(make(), live);
      expect(result).toMatchObject({ status: 400, code: 'malformed_json', options: {}, logged: { code: 'malformed_json' } });
      expect(buildBodyOf(result)).toEqual({ error: { code: 'malformed_json', message: MESSAGE_BY_CODE.malformed_json } });
    }
    const quoting = Object.assign(new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY(), { message: `Unexpected token ${secret} in JSON at position 3` });
    expect(JSON.stringify(mapError(quoting, live))).not.toContain(secret);
  });

  it('matches a parse error by its code, never by a message that merely looks like one', () => {
    expect(mapError(clientError('Body is not valid JSON but content-type is set to application/json', 'FST_ERR_OTHER'), live)).toMatchObject({ status: 500, code: 'internal_error' });
  });

  it('keeps the rule order: an unknown route is 404, an AppError keeps its code, and 413 and 415 still reach the interim rule', () => {
    expect(mapError(new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY(), { is404: true })).toMatchObject({ status: 404, code: 'route_not_found' });
    expect(mapError(Object.assign(new AppError('not_found'), { code: 'not_found' }), live)).toMatchObject({ status: 404, code: 'not_found' });
    expect(mapError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), { is404: true })).toMatchObject({ status: 404, code: 'route_not_found' });
    for (const [code, statusCode] of [['FST_ERR_CTP_BODY_TOO_LARGE', 413], ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 415]] as const) {
      const error = Object.assign(new Error('quoted input'), { code, statusCode });
      expect(mapError(error, live)).toMatchObject({ status: 500, code: 'internal_error', logged: { code } });
    }
  });

  it('answers a database outage from a thrown error with 503 and the contract body, and logs a safe code and the fixed message', async () => {
    const secret = marker();
    const { app, capture } = appWith();
    app.get('/down', async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:5432 ${secret}`), { code: 'ECONNREFUSED' });
    });
    const response = await injectLocal(app, { method: 'GET', url: '/down' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'database_unavailable', message: 'The database is not reachable. Try again shortly.' } });
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ level: 'error', status: 503, err: { code: 'ECONNREFUSED', message: 'The database is not reachable. Try again shortly.' } });
    expect(response.body + capture.lines.join('\n')).not.toContain(secret);
    await app.close();
  });
});

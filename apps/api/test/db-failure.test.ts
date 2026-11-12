import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyDatabaseFailure } from '../src/db/failure';
import { MESSAGE_BY_CODE, mapError } from '../src/errors';

const marker = (): string => randomBytes(12).toString('hex');
const live = { is404: false };
const withCode = (code: string, text = 'database error'): Error => Object.assign(new Error(text), { code });
const unavailable = { status: 503, code: 'database_unavailable' };
const generic = { status: 500, code: 'internal_error' };

const DRIVER_TEXTS = [
  ['timeout exceeded when trying to connect', 'POOL_TIMEOUT'],
  ['Connection terminated due to connection timeout', 'CONNECT_TIMEOUT'],
  ['Query read timeout', 'QUERY_TIMEOUT'],
  ['Connection terminated unexpectedly', 'CONNECTION_LOST'],
] as const;

describe('codes that mean the database is unavailable', () => {
  it.each(['57P01', '57P03', '57014', '08000', '08003', '08006', '08001', '08004', '08007', '08P01', 'ECONNREFUSED', 'ECONNRESET'])('%s gives 503 database_unavailable with that code in the log', (code) => {
    expect(classifyDatabaseFailure(withCode(code))).toEqual({ unavailable: true, code });
    const result = mapError(withCode(code), live);
    expect(result).toMatchObject({ ...unavailable, logged: { code, message: MESSAGE_BY_CODE.database_unavailable } });
  });

  it.each(['0800', '080000', '18000', '57P02', '23505', '42P01', 'XX000', '28P01', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'econnrefused'])('%s stays a generic 500', (code) => {
    expect(classifyDatabaseFailure(withCode(code))).toBeUndefined();
    expect(mapError(withCode(code), live)).toMatchObject({ ...generic, logged: { code, message: MESSAGE_BY_CODE.internal_error } });
  });
});

describe('driver timeouts, which carry no code', () => {
  it.each(DRIVER_TEXTS)('recognises the exact text "%s" and logs the fixed code %s', (text, fixedCode) => {
    expect(classifyDatabaseFailure(new Error(text))).toEqual({ unavailable: true, code: fixedCode });
    expect(mapError(new Error(text), live)).toMatchObject({ ...unavailable, logged: { code: fixedCode, message: MESSAGE_BY_CODE.database_unavailable } });
  });

  it.each(DRIVER_TEXTS)('does not match "%s" with anything added, removed or changed in case', (text) => {
    const secret = marker();
    for (const variant of [`${text} ${secret}`, `${secret} ${text}`, text.toUpperCase(), `${text}.`, text.slice(1), '']) {
      expect(classifyDatabaseFailure(new Error(variant)), variant).toBeUndefined();
      expect(mapError(new Error(variant), live), variant).toMatchObject(generic);
    }
  });

  it('leaves the two texts the driver cannot produce here as a generic 500', () => {
    for (const text of ['timeout expired', 'Connection terminated']) {
      expect(mapError(new Error(text), live), text).toMatchObject(generic);
    }
  });

  it.each(DRIVER_TEXTS)('is not fooled by "%s" arriving as server-sourced or title-shaped text', (text) => {
    expect(classifyDatabaseFailure(withCode('XX000', text))).toBeUndefined();
    expect(classifyDatabaseFailure(Object.assign(new Error(text), { severity: 'ERROR' }))).toBeUndefined();
    expect(classifyDatabaseFailure(Object.assign(new Error(text), { code: '23505', severity: 'ERROR' }))).toBeUndefined();
    expect(classifyDatabaseFailure({ message: text })).toBeUndefined();
    expect(classifyDatabaseFailure(text)).toBeUndefined();
  });
});

describe('a client error is never reported as an outage', () => {
  it('ignores ECONNRESET and a driver text on an error with a 4xx statusCode', () => {
    for (const error of [Object.assign(withCode('ECONNRESET'), { statusCode: 400 }), Object.assign(new Error('Query read timeout'), { statusCode: 408 })]) {
      expect(classifyDatabaseFailure(error)).toBeUndefined();
      expect(mapError(error, live)).toMatchObject(generic);
    }
  });

  it('still reports an error whose statusCode is not a 4xx', () => {
    expect(classifyDatabaseFailure(Object.assign(withCode('ECONNRESET'), { statusCode: 500 }))).toEqual({ unavailable: true, code: 'ECONNRESET' });
  });
});

describe('the cause chain (Drizzle wraps the driver error)', () => {
  const wrapper = (cause: unknown, secret: string): Error => Object.assign(new Error(`Failed query: SELECT ${secret}\nparams: ${secret}`), { cause, query: secret, params: [secret] });

  it('finds a code or a driver text on the cause and maps the same way', () => {
    const secret = marker();
    expect(mapError(wrapper(withCode('57P01'), secret), live)).toMatchObject({ ...unavailable, logged: { code: '57P01' } });
    expect(mapError(wrapper(new Error('Query read timeout'), secret), live)).toMatchObject({ ...unavailable, logged: { code: 'QUERY_TIMEOUT' } });
    expect(mapError(wrapper(withCode('23505'), secret), live)).toMatchObject(generic);
  });

  it('never lets the wrapper message reach the logged record', () => {
    const secret = marker();
    expect(JSON.stringify(mapError(wrapper(withCode('ECONNREFUSED', `connect ECONNREFUSED 127.0.0.1:5 ${secret}`), secret), live))).not.toContain(secret);
  });

  it('finds the first matching error along the chain, the outer one first', () => {
    const inner = withCode('57P01');
    const outer = Object.assign(new Error('outer'), { code: 'ECONNRESET', cause: inner });
    expect(classifyDatabaseFailure(outer)).toEqual({ unavailable: true, code: 'ECONNRESET' });
  });

  it('looks at five errors along the chain and no further, which also ends a cycle', () => {
    const chain = (length: number): Error => {
      let tail: Error = withCode('57P01');
      for (let index = 1; index < length; index += 1) tail = Object.assign(new Error('link'), { cause: tail });
      return tail;
    };
    expect(classifyDatabaseFailure(chain(5))).toEqual({ unavailable: true, code: '57P01' });
    expect(classifyDatabaseFailure(chain(6))).toBeUndefined();
    const first = new Error('a');
    const second = Object.assign(new Error('b'), { cause: first });
    Object.assign(first, { cause: second });
    expect(classifyDatabaseFailure(first)).toBeUndefined();
    expect(mapError(first, live)).toMatchObject(generic);
  });
});

describe('values that are not ordinary errors', () => {
  it('gives undefined, never an exception, for null, primitives and plain objects', () => {
    for (const value of [null, undefined, 'ECONNREFUSED', 7, true, {}, { code: 5 }, [], Symbol('x')]) {
      expect(classifyDatabaseFailure(value), String(value)).toBeUndefined();
      expect(mapError(value, live), String(value)).toMatchObject(generic);
    }
  });

  it('gives undefined when a getter throws, on any property the classifier reads', () => {
    const throwing = (name: string, base: object = new Error('x')): object =>
      Object.defineProperty(base, name, {
        get() {
          throw new Error(`${name} getter`);
        },
      });
    for (const name of ['code', 'cause', 'message', 'severity', 'statusCode']) {
      expect(classifyDatabaseFailure(throwing(name)), name).toBeUndefined();
    }
    for (const name of ['code', 'cause', 'message', 'severity']) {
      expect(mapError(throwing(name), live), name).toMatchObject(generic);
    }
  });

  it('gives undefined for a Proxy whose traps throw', () => {
    const hostile = new Proxy(new Error('x'), {
      has() {
        throw new Error('has');
      },
      get() {
        throw new Error('get');
      },
    });
    expect(classifyDatabaseFailure(hostile)).toBeUndefined();
  });

  it('never reads AggregateError.errors, whether or not the aggregate itself is classified', () => {
    let reads = 0;
    const aggregate = (code: string | undefined): AggregateError => {
      const error = new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:5')], 'agg');
      Object.defineProperty(error, 'errors', {
        get() {
          reads += 1;
          throw new Error('errors getter');
        },
      });
      return code === undefined ? error : Object.assign(error, { code });
    };
    expect(classifyDatabaseFailure(aggregate(undefined))).toBeUndefined();
    expect(classifyDatabaseFailure(aggregate('ECONNREFUSED'))).toEqual({ unavailable: true, code: 'ECONNREFUSED' });
    expect(reads).toBe(0);
  });
});

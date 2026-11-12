import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeError, errorCode } from '../src/logger';

const marker = (): string => randomBytes(12).toString('hex');

describe('errorCode', () => {
  it('returns a short plain string code', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(errorCode({ code: '57P01' })).toBe('57P01');
  });

  it('returns unknown for a missing, long or unplain code and for values that are not objects', () => {
    for (const value of [null, undefined, 'text', 42, true, {}, { code: 5 }, { code: 'has spaces' }, { code: 'x'.repeat(33) }, { code: '' }]) {
      expect(errorCode(value), String(value)).toBe('unknown');
    }
  });

  it('never throws: a throwing getter, a throwing has trap and a throwing get trap all give unknown', () => {
    const getter = {
      get code(): string {
        throw new Error('getter');
      },
    };
    const hasTrap = new Proxy(
      {},
      {
        has() {
          throw new Error('has');
        },
      },
    );
    const getTrap = new Proxy(
      { code: 'X' },
      {
        get() {
          throw new Error('get');
        },
      },
    );
    for (const value of [getter, hasTrap, getTrap]) {
      expect(errorCode(value)).toBe('unknown');
    }
  });
});

describe('describeError', () => {
  it.each(['database pool error', 'shutdown failed', 'cleanup after failed start failed'] as const)('gives a code and a fixed text for %s, never the error message', (key) => {
    const secret = marker();
    const error = Object.assign(new Error(`failed ${secret}`), { code: 'XX000', detail: secret });
    const described = describeError(error, key);
    expect(described.code).toBe('XX000');
    expect(described.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(described)).not.toContain(secret);
    expect(describeError(new Error(secret), key).message).toBe(described.message);
  });

  it('gives each call site its own text', () => {
    const texts = (['database pool error', 'shutdown failed', 'cleanup after failed start failed'] as const).map((key) => describeError(null, key).message);
    expect(new Set(texts).size).toBe(3);
  });
});

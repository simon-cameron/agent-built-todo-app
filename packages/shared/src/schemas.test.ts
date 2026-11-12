import { describe, expect, it } from 'vitest';
import { parseCreateBody, parseEditBody, parseSetDone } from './schemas';

type Parser = (body: unknown) => { ok: boolean; details?: readonly unknown[]; value?: unknown };
const detail = (field: string, reason: string) => ({ field, reason });

const titleEndpoints: readonly [string, Parser][] = [
  ['create', parseCreateBody],
  ['edit', parseEditBody],
];

describe.each(titleEndpoints)('title body (%s)', (_name, parse) => {
  it.each([
    ['array', []],
    ['array with items', [{ title: 'a' }]],
    ['string', 'x'],
    ['number', 5],
    ['boolean', true],
    ['null', null],
  ])('rejects a %s body as field "" invalid_type', (_label, body) => {
    expect(parse(body)).toEqual({ ok: false, details: [detail('', 'invalid_type')] });
  });

  it('reports a missing title as required, including for {}', () => {
    expect(parse({})).toEqual({ ok: false, details: [detail('title', 'required')] });
  });

  it.each([
    ['null', null],
    ['number', 5],
    ['boolean', false],
    ['array', ['a']],
    ['object', { a: 1 }],
  ])('rejects a %s title as invalid_type', (_label, title) => {
    expect(parse({ title })).toEqual({ ok: false, details: [detail('title', 'invalid_type')] });
  });

  it('rejects empty and whitespace-only titles as empty', () => {
    expect(parse({ title: '' })).toEqual({ ok: false, details: [detail('title', 'empty')] });
    expect(parse({ title: '   ' })).toEqual({ ok: false, details: [detail('title', 'empty')] });
  });

  it.each([
    ['tab', '\t\t'],
    ['no-break space', '\u00a0\u00a0'],
    ['em space', '\u2003\u2003'],
  ])('rejects a %s-only title as empty', (_label, title) => {
    expect(parse({ title })).toEqual({ ok: false, details: [detail('title', 'empty')] });
  });

  it('counts emoji as code points: 201 is too_long, 200 is accepted', () => {
    expect(parse({ title: '\u{1F600}'.repeat(201) })).toEqual({
      ok: false,
      details: [detail('title', 'too_long')],
    });
    expect(parse({ title: '\u{1F600}'.repeat(200) }).ok).toBe(true);
  });

  it.each([
    ['lone low surrogate', '\udc00'],
    ['padded U+0000', '  \u0000  '],
    ['lone low surrogate inside text', 'a\udc00b'],
  ])('rejects a %s as invalid_character', (_label, title) => {
    expect(parse({ title })).toEqual({ ok: false, details: [detail('title', 'invalid_character')] });
  });

  it('lists an invalid title first, then the unknown key', () => {
    expect(parse({ done: 1, title: 'a\u0000b' })).toEqual({
      ok: false,
      details: [detail('title', 'invalid_character'), detail('done', 'unknown_field')],
    });
    expect(parse({ done: 1, title: null })).toEqual({
      ok: false,
      details: [detail('title', 'invalid_type'), detail('done', 'unknown_field')],
    });
  });

  it('rejects a title over 200 code points as too_long and accepts exactly 200', () => {
    expect(parse({ title: 'a'.repeat(201) })).toEqual({ ok: false, details: [detail('title', 'too_long')] });
    expect(parse({ title: 'a'.repeat(200) }).ok).toBe(true);
  });

  it('rejects U+0000 and a lone surrogate as invalid_character', () => {
    expect(parse({ title: 'a\u0000b' })).toEqual({ ok: false, details: [detail('title', 'invalid_character')] });
    expect(parse({ title: '\ud800' })).toEqual({ ok: false, details: [detail('title', 'invalid_character')] });
  });

  it('returns the trimmed title on success and counts an emoji as one', () => {
    expect(parse({ title: '  Buy milk  ' })).toEqual({ ok: true, value: { title: 'Buy milk' } });
    expect(parse({ title: '\u{1F600}'.repeat(200) }).ok).toBe(true);
  });

  it.each(['done', 'createdAt', 'id'])('rejects extra key %s as unknown_field', (key) => {
    expect(parse({ title: 'x', [key]: 1 })).toEqual({ ok: false, details: [detail(key, 'unknown_field')] });
  });

  it('lists the title failure first, then unknown keys in code-unit order (uppercase before lowercase)', () => {
    expect(parse({ zeta: 1, title: '', alpha: 2, Beta: 3, done: true })).toEqual({
      ok: false,
      details: [
        detail('title', 'empty'),
        detail('Beta', 'unknown_field'),
        detail('alpha', 'unknown_field'),
        detail('done', 'unknown_field'),
        detail('zeta', 'unknown_field'),
      ],
    });
  });

  it('lists a missing title first, then the unknown key', () => {
    expect(parse({ id: 1 })).toEqual({
      ok: false,
      details: [detail('title', 'required'), detail('id', 'unknown_field')],
    });
  });

  it('reports a JSON-parsed __proto__ key as unknown without crashing', () => {
    const body: unknown = JSON.parse('{"title":"x","__proto__":{"polluted":true}}');
    expect(parse(body)).toEqual({ ok: false, details: [detail('__proto__', 'unknown_field')] });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('set-done body', () => {
  it.each([
    ['array', []],
    ['string', 'true'],
    ['number', 1],
    ['boolean', true],
    ['null', null],
  ])('rejects a %s body as field "" invalid_type', (_label, body) => {
    expect(parseSetDone(body)).toEqual({ ok: false, details: [detail('', 'invalid_type')] });
  });

  it('reports a missing done as required, including for {}', () => {
    expect(parseSetDone({})).toEqual({ ok: false, details: [detail('done', 'required')] });
  });

  it.each([
    ['null', null],
    ['string true', 'true'],
    ['number 1', 1],
    ['number 0', 0],
    ['array', [true]],
    ['object', {}],
  ])('rejects done as %s with invalid_type', (_label, done) => {
    expect(parseSetDone({ done })).toEqual({ ok: false, details: [detail('done', 'invalid_type')] });
  });

  it('accepts true and false', () => {
    expect(parseSetDone({ done: true })).toEqual({ ok: true, value: { done: true } });
    expect(parseSetDone({ done: false })).toEqual({ ok: true, value: { done: false } });
  });

  it('rejects any other key as unknown_field, including title', () => {
    expect(parseSetDone({ done: true, title: 'x' })).toEqual({
      ok: false,
      details: [detail('title', 'unknown_field')],
    });
  });

  it('lists the done failure first, then unknown keys in code-unit order', () => {
    expect(parseSetDone({ b: 1, done: 'yes', A: 2 })).toEqual({
      ok: false,
      details: [detail('done', 'invalid_type'), detail('A', 'unknown_field'), detail('b', 'unknown_field')],
    });
  });

  it('reports a JSON-parsed __proto__ key as unknown without crashing', () => {
    const body: unknown = JSON.parse('{"done":true,"__proto__":{"polluted":true}}');
    expect(parseSetDone(body)).toEqual({ ok: false, details: [detail('__proto__', 'unknown_field')] });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('lists a missing done first, then unknown keys', () => {
    expect(parseSetDone({ title: 'x' })).toEqual({
      ok: false,
      details: [detail('done', 'required'), detail('title', 'unknown_field')],
    });
  });
});

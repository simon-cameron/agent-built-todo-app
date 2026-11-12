import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { safeStack } from '../src/logger';
import { spawnTsx } from './child';

const marker = (): string => randomBytes(12).toString('hex');
/** Every line of a kept stack is exactly `    at <location>`. */
const FRAMES_ONLY = /^ {4}at (?:node:|file:\/\/)?[A-Za-z0-9_\-./\\@+~%]+:\d+:\d+$/;
const linesOf = (stack: string | undefined): string[] => (stack ?? '').split('\n');

/** An error whose stack is exactly the given frames under a normal header. */
function withFrames(frames: readonly string[], message = 'm'): Error {
  const error = new Error(message);
  error.stack = [`Error: ${message}`, ...frames].join('\n');
  return error;
}

describe('safeStack on ordinary errors', () => {
  it('keeps only frame locations and never the message', () => {
    const secret = marker();
    const stack = safeStack(new Error(`failed ${secret}`));
    expect(stack).toBeDefined();
    for (const line of linesOf(stack)) expect(line).toMatch(FRAMES_ONLY);
    expect(stack).not.toContain(secret);
    expect(stack).not.toContain('Error');
  });

  it('keeps the frames of an error with an empty message', () => {
    const stack = safeStack(new Error(''));
    for (const line of linesOf(stack)) expect(line).toMatch(FRAMES_ONLY);
    expect(stack).toBeDefined();
  });

  it('gives nothing for a value that is not an Error', () => {
    for (const value of [null, undefined, 'text', 4, { message: 'm', stack: 'm\n    at /x:1:1' }]) expect(safeStack(value), String(value)).toBeUndefined();
  });
});

describe('safeStack frame rules', () => {
  it('keeps frames without a closing parenthesis and async frames, and drops function names', () => {
    const secret = marker();
    const error = withFrames([`    at ${secret} (/a/b.ts:1:2)`, '    at /a/c.ts:3:4', '    at async /a/d.ts:5:6', '    at async Foo.bar [as baz] (/a/e.ts:7:8)', '    at new Thing (file:///a/f.ts:9:10)', '    at node:internal/main:11:12']);
    expect(safeStack(error)).toBe(['    at /a/b.ts:1:2', '    at /a/c.ts:3:4', '    at /a/d.ts:5:6', '    at /a/e.ts:7:8', '    at file:///a/f.ts:9:10', '    at node:internal/main:11:12'].join('\n'));
  });

  it('drops lines that do not match the pattern, and lines that are too long, instead of trimming them', () => {
    const secret = marker();
    const error = withFrames([
      '    at /a/ok.ts:1:1',
      '    at Object.<anonymous> (<anonymous>)',
      `    at /a/query.js?${secret}:1:1`,
      `    at /a/with space ${secret}.ts:1:1`,
      `    at ${secret}`,
      `    at /${'a'.repeat(300)}.ts:1:1`,
      `      at /a/indented.ts:1:1`,
      `    at /a/after.ts:2:2 ${secret}`,
      '    at /a/last.ts:3:3',
    ]);
    expect(safeStack(error)).toBe(['    at /a/ok.ts:1:1', '    at /a/last.ts:3:3'].join('\n'));
  });

  it('keeps at most 6 frames', () => {
    const frames = Array.from({ length: 20 }, (_, index) => `    at /a/f${index}.ts:1:1`);
    expect(linesOf(safeStack(withFrames(frames)))).toHaveLength(6);
  });

  it('keeps at most 1500 characters', () => {
    const frames = Array.from({ length: 6 }, (_, index) => `    at /${String(index).repeat(250)}.ts:1:1`);
    const stack = safeStack(withFrames(frames));
    expect(stack).toBeDefined();
    expect((stack ?? '').length).toBeLessThanOrEqual(1500);
    expect(linesOf(stack).length).toBeLessThan(6);
  });

  it('gives nothing when no frame survives', () => {
    expect(safeStack(withFrames(['    at Object.<anonymous> (<anonymous>)', '    at async Promise.all (index 0)']))).toBeUndefined();
    expect(safeStack(withFrames([]))).toBeUndefined();
  });

  it('gives nothing when the first line after the header is not a frame', () => {
    const error = new Error('m');
    error.stack = 'Error: m\nsomething else\n    at /a/b.ts:1:1';
    expect(safeStack(error)).toBeUndefined();
  });
});

describe('safeStack fails closed when the message cannot be cut out cleanly', () => {
  const original = 'abcdefghij';
  const changedTo = (message: string): Error => {
    const error = new Error(original);
    // The runtime may build the stack lazily from the current message; reading it here fixes the original header first.
    void error.stack;
    error.message = message;
    return error;
  };

  it('gives nothing for a message changed to a prefix, a fragment or an extension of the original', () => {
    for (const message of ['abcde', 'cdef', `${original}more`, 'xyz']) expect(safeStack(changedTo(message)), message).toBeUndefined();
  });

  it('never shows the original text for a message changed to a suffix', () => {
    const stack = safeStack(changedTo('fghij'));
    for (const line of linesOf(stack)) expect(line).toMatch(FRAMES_ONLY);
    expect(stack ?? '').not.toContain('abcde');
  });

  it('cuts a message that contains a fake frame line, so the fake frame never appears', () => {
    const secret = marker();
    const stack = safeStack(new Error(`first ${secret}\n    at /x:1:1)\nlast ${secret}`));
    expect(stack).toBeDefined();
    expect(stack).not.toContain('/x:1:1');
    expect(stack).not.toContain(secret);
  });

  it('never shows text from a name that carries a marker', () => {
    const secret = marker();
    class Named extends Error {}
    Named.prototype.name = `Named ${secret}`;
    const stack = safeStack(new Named(`message ${secret}`));
    expect(stack).toBeDefined();
    expect(stack).not.toContain(secret);
  });

  it('gives nothing when the message is found inside the name and not at the end of a one-line header', () => {
    class Named extends Error {}
    Named.prototype.name = 'Named-x';
    expect(safeStack(new Named('x'))).toBeUndefined();
  });

  it('gives nothing for a stack replaced by plain text', () => {
    const error = new Error('m');
    error.stack = 'just some text';
    expect(safeStack(error)).toBeUndefined();
    Object.defineProperty(error, 'stack', { value: undefined });
    expect(safeStack(error)).toBeUndefined();
  });

  it('gives nothing when the stack or the message getter throws, or returns a non-string', () => {
    const throwing = (name: 'stack' | 'message'): Error =>
      Object.defineProperty(new Error('m'), name, {
        get() {
          throw new Error(`${name} getter`);
        },
      });
    expect(safeStack(throwing('stack'))).toBeUndefined();
    expect(safeStack(throwing('message'))).toBeUndefined();
    expect(safeStack(Object.defineProperty(new Error('m'), 'message', { value: 7 }))).toBeUndefined();
  });

  it('reads the stack and the message once, so a getter that answers differently the second time cannot change the result', () => {
    const secret = marker();
    const error = new Error('m');
    const first = error.stack;
    let reads = 0;
    Object.defineProperty(error, 'stack', {
      get() {
        reads += 1;
        return reads === 1 ? first : `Error: m\n    at /${secret}.ts:1:1`;
      },
    });
    const stack = safeStack(error);
    expect(reads).toBe(1);
    expect(stack).toBeDefined();
    expect(stack).not.toContain(secret);
  });
});

describe('safeStack under real tsx', () => {
  it('keeps frames only and never a marker, for every marker case', async () => {
    const secret = marker();
    const child = spawnTsx(['test/fixtures/stack-entry.ts'], { PATH: process.env['PATH'] ?? '', MARKER: secret });
    try {
      expect(await child.exited).toBe(0);
    } finally {
      child.killGroup();
    }
    expect(child.stderr()).toBe('');
    expect(child.stdout()).not.toContain(secret);
    const result = JSON.parse(child.stdout()) as Record<string, string | null>;
    expect(Object.keys(result).sort()).toEqual(['changed', 'empty', 'marker', 'multiline', 'named', 'plain']);
    for (const name of ['plain', 'marker', 'multiline', 'named', 'empty']) {
      expect(result[name], name).not.toBeNull();
      for (const line of linesOf(result[name] ?? '')) expect(line, name).toMatch(FRAMES_ONLY);
    }
    expect(result['changed']).toBeNull();
  }, 30_000);
});

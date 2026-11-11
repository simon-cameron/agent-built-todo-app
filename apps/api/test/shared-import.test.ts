import { describe, expect, it } from 'vitest';
import { TITLE_MAX_LENGTH, validateTitle } from '@todo/shared'; // ADR-5 source-consumed shared package

describe('shared package import', () => {
  it('resolves the single title limit and rule from the shared source', () => {
    expect(TITLE_MAX_LENGTH).toBe(200);
    expect(validateTitle('  ok  ')).toEqual({ ok: true, value: 'ok' });
  });
});

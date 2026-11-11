import { describe, expect, it } from 'vitest';

describe('shared placeholder', () => {
  it('runs a test in the shared project', () => {
    expect(1 + 1).toBe(2);
  });
});

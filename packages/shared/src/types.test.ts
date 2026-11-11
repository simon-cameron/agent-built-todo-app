import { describe, expect, expectTypeOf, it } from 'vitest';
import { FILTERS } from './types';
import type { Filter, Todo } from './types'; // ADR-5 type name fixed by the contract

describe('shared types', () => {
  it('has exactly id, title, done and createdAt on the item type', () => {
    expectTypeOf<keyof Todo>().toEqualTypeOf<'id' | 'title' | 'done' | 'createdAt'>(); // ADR-5
    expectTypeOf<Todo['id']>().toEqualTypeOf<number>(); // ADR-5
    expectTypeOf<Todo['title']>().toEqualTypeOf<string>(); // ADR-5
    expectTypeOf<Todo['done']>().toEqualTypeOf<boolean>(); // ADR-5
    expectTypeOf<Todo['createdAt']>().toEqualTypeOf<string>(); // ADR-5
  });

  it('lists exactly the three filters, frozen', () => {
    expect([...FILTERS]).toEqual(['all', 'active', 'done']);
    expect(Object.isFrozen(FILTERS)).toBe(true);
    expectTypeOf<Filter>().toEqualTypeOf<'all' | 'active' | 'done'>();
  });
});

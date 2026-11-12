import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES, VALIDATION_REASONS, isValidationReason } from './errors';
import type { ErrorCode, ValidationReason } from './errors';
import type { TitleFailureReason } from './title';

describe('error codes and reasons', () => {
  it('lists exactly the twelve contract error codes', () => {
    expect([...ERROR_CODES]).toEqual([
      'validation_error',
      'invalid_filter',
      'invalid_id',
      'malformed_json',
      'host_not_allowed',
      'origin_not_allowed',
      'not_found',
      'route_not_found',
      'payload_too_large',
      'unsupported_media_type',
      'internal_error',
      'database_unavailable',
    ]);
    expect(new Set(ERROR_CODES).size).toBe(12);
  });

  it('lists exactly the six contract reasons', () => {
    expect([...VALIDATION_REASONS]).toEqual([
      'required',
      'invalid_type',
      'empty',
      'too_long',
      'invalid_character',
      'unknown_field',
    ]);
  });

  it('freezes both lists', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(VALIDATION_REASONS)).toBe(true);
  });

  it('narrows reasons with the type guard', () => {
    expect(isValidationReason('empty')).toBe(true);
    expect(isValidationReason('nope')).toBe(false);
  });

  it('keeps the types in step with the lists', () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<(typeof ERROR_CODES)[number]>();
    expectTypeOf<ValidationReason>().toEqualTypeOf<(typeof VALIDATION_REASONS)[number]>();
    expectTypeOf<TitleFailureReason>().toExtend<ValidationReason>();
  });
});

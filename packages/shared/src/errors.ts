/** The closed list of API error codes (API contract, error codes and status matrix). */
export const ERROR_CODES = Object.freeze([
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
] as const);

/** One of the closed error codes. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The closed list of reasons used in `details` entries of a `validation_error`. */
export const VALIDATION_REASONS = Object.freeze([
  'required',
  'invalid_type',
  'empty',
  'too_long',
  'invalid_character',
  'unknown_field',
] as const);

/** One of the closed validation reasons. */
export type ValidationReason = (typeof VALIDATION_REASONS)[number];

/** One entry of the `details` list: which field failed and why. `field` is `""` for the whole body. */
export interface ValidationDetail {
  readonly field: string;
  readonly reason: ValidationReason;
}

/**
 * Type guard for {@link ValidationReason}.
 *
 * @param value - Any string.
 */
export function isValidationReason(value: string): value is ValidationReason {
  return (VALIDATION_REASONS as readonly string[]).includes(value);
}

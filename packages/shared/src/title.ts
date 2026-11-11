/** Maximum title length, counted in Unicode code points after trimming. */
export const TITLE_MAX_LENGTH = 200;

/** Why a title was rejected. Never carries the title text itself. */
export type TitleFailureReason = 'invalid_type' | 'invalid_character' | 'empty' | 'too_long';

/** Result of {@link validateTitle}: the trimmed value, or the single failure reason. */
export type TitleResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: TitleFailureReason };

/**
 * Validates a title. Used by both the API and the web client so they cannot disagree.
 *
 * Order: non-string is `invalid_type`; the value is trimmed with `String.prototype.trim`;
 * U+0000 or a lone surrogate is `invalid_character`; then the code point count decides
 * `empty` (0) or `too_long` (over {@link TITLE_MAX_LENGTH}). Character checks run before
 * length checks. Never throws and never echoes the input.
 *
 * @param raw - Any value; only strings can be valid.
 * @returns `{ ok: true, value }` with the trimmed title, or `{ ok: false, reason }`.
 */
export function validateTitle(raw: unknown): TitleResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'invalid_type' };
  }
  const trimmed = raw.trim();
  if (trimmed.includes('\u0000') || !trimmed.isWellFormed()) {
    return { ok: false, reason: 'invalid_character' };
  }
  const length = Array.from(trimmed).length;
  if (length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (length > TITLE_MAX_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, value: trimmed };
}

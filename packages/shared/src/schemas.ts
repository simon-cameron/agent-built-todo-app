import { z } from 'zod';
import { isValidationReason } from './errors';
import type { ValidationDetail, ValidationReason } from './errors';
import { validateTitle } from './title';

/** Outcome of a parse helper: the typed value, or the exact contract `details` list. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly details: readonly ValidationDetail[] };

const titleSchema = z.unknown().transform((raw, ctx) => {
  const result = validateTitle(raw);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.reason });
    return z.NEVER;
  }
  return result.value;
});

/** Strict body schema for creating an item: only `title` is allowed. */
export const createBodySchema = z.strictObject({ title: titleSchema });

/** Strict body schema for editing an item: only `title` is allowed and it is required. */
export const editBodySchema = z.strictObject({ title: titleSchema });

/** Strict body schema for setting the done state: only `done` (a boolean) is allowed. */
export const setDoneBodySchema = z.strictObject({ done: z.boolean() });

function toDetails(error: z.ZodError, ownField: string, body: unknown): ValidationDetail[] {
  const issues = error.issues;
  if (issues.some((issue) => issue.path.length === 0 && issue.code === 'invalid_type')) {
    return [{ field: '', reason: 'invalid_type' }];
  }
  const details: ValidationDetail[] = [];
  const own = issues.find((issue) => issue.path[0] === ownField);
  if (own !== undefined) {
    const present = typeof body === 'object' && body !== null && Object.hasOwn(body, ownField);
    let reason: ValidationReason = 'invalid_type';
    if (!present) {
      reason = 'required';
    } else if (own.code === 'custom' && isValidationReason(own.message)) {
      reason = own.message;
    }
    details.push({ field: ownField, reason });
  }
  const unknownKeys: string[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      unknownKeys.push(...issue.keys);
    }
  }
  // Default sort compares UTF-16 code units in ascending order, as the contract requires.
  for (const key of unknownKeys.sort()) {
    details.push({ field: key, reason: 'unknown_field' });
  }
  return details;
}

function parseWith<T>(schema: z.ZodType<T>, ownField: string, body: unknown): ParseResult<T> {
  const result = schema.safeParse(body);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, details: toDetails(result.error, ownField, body) };
}

/**
 * Validates a create body. Returns the trimmed title, or the exact `details` for the contract.
 *
 * @param body - The parsed JSON body (any value).
 */
export function parseCreateBody(body: unknown): ParseResult<{ readonly title: string }> {
  return parseWith(createBodySchema, 'title', body);
}

/**
 * Validates an edit body. Returns the trimmed title, or the exact `details` for the contract.
 *
 * @param body - The parsed JSON body (any value).
 */
export function parseEditBody(body: unknown): ParseResult<{ readonly title: string }> {
  return parseWith(editBodySchema, 'title', body);
}

/**
 * Validates a set-done body. Returns the boolean, or the exact `details` for the contract.
 *
 * @param body - The parsed JSON body (any value).
 */
export function parseSetDone(body: unknown): ParseResult<{ readonly done: boolean }> {
  return parseWith(setDoneBodySchema, 'done', body);
}

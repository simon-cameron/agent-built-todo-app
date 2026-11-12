/** The few logging calls the API makes; a pino logger satisfies it. Fields are always safe values, never error objects. */
export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

const SAFE_CODE = /^[A-Za-z0-9_]{1,32}$/;

/** The error's string `code` when it is short and plain, otherwise `unknown`. */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
  }
  return 'unknown';
}

/** The only error fields that may be logged: pg `detail`, `where`, SQL text and parameters stay out. */
export function describeError(error: unknown): { code: string; message: string } {
  return { code: errorCode(error), message: error instanceof Error ? error.message : 'A non-error value was thrown.' };
}

import pino, { type DestinationStream } from 'pino';

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

/** One JSON logger: level as a label, ISO UTC time, no pid or hostname. The default destination is synchronous so lines survive process.exit. */
export function createLogger(destination: DestinationStream = pino.destination({ fd: 1, sync: true })): pino.Logger {
  return pino(
    {
      level: 'info',
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      // The default err serializer adds type and stack fields and, for a real Error, every enumerable property (pg puts SQL there).
      // Call sites pass already-safe plain objects; an Error that slips through is reduced to its code.
      serializers: { err: (value: unknown) => (value instanceof Error ? { code: errorCode(value) } : value) },
      // Second layer only: no log call is meant to carry these fields at all.
      redact: { paths: ['password', 'dbPassword', '*.password', '*.dbPassword'], censor: '[redacted]' },
    },
    destination,
  );
}

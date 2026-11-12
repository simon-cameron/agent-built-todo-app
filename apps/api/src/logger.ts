import pino, { type DestinationStream } from 'pino';

/** The few logging calls the API makes; a pino logger satisfies it. Fields are always safe values, never error objects. */
export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

const SAFE_CODE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * The error's string `code` when it is short and plain, otherwise `unknown`.
 * Total: a throwing getter or a Proxy trap on a hostile value answers `unknown`, because this runs inside the fatal handlers
 * and an exception there would make Node print the raw error and exit with its own code.
 */
export function errorCode(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const { code } = error;
      if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

/** The only fixed texts a log line may carry for an error, one per call site. The error's own message is never one of them. */
const FIXED_LOG_MESSAGES = {
  'database pool error': 'The database pool reported an error.',
  'shutdown failed': 'Shutdown did not complete cleanly.',
  'cleanup after failed start failed': 'Cleanup after the failed start did not complete.',
} as const;

export type FixedLogKey = keyof typeof FIXED_LOG_MESSAGES;

/** The only error fields that may be logged: a safe code and the fixed text for the call site. Driver text, SQL and parameters stay out. */
export function describeError(error: unknown, key: FixedLogKey): { code: string; message: string } {
  return { code: errorCode(error), message: FIXED_LOG_MESSAGES[key] };
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

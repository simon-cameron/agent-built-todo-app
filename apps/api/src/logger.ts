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

const MAX_STACK_FRAMES = 6;
const MAX_STACK_CHARACTERS = 1500;
const MAX_FRAME_LINE_LENGTH = 300;
/**
 * A whole stack-frame line, nothing else: four spaces, `at`, an optional `async`, an optional function part (identifier characters and
 * a few brackets, discarded) and a location of path characters, `node:` or `file://` plus `:line:col`. Node prints anonymous and async
 * frames without the closing parenthesis, so it is optional. Only the captured location is ever kept.
 */
const FRAME_LINE = /^ {4}at (?:async )?(?:[A-Za-z0-9_$.<>[\] ]+ \()?((?:node:|file:\/\/)?[A-Za-z0-9_\-./\\@+~%]+:\d+:\d+)\)?$/;

function frameLocation(line: string): string | undefined {
  return line.length > MAX_FRAME_LINE_LENGTH ? undefined : FRAME_LINE.exec(line)?.[1];
}

/** The lines after the header, or undefined unless the message sits in a single-line header and a frame line follows it. */
function linesAfterHeader(stack: string, message: string): string[] | undefined {
  const start = message === '' ? Math.max(stack.indexOf('\n'), 0) : stack.indexOf(message);
  if (start < 0) return undefined;
  const header = stack.slice(0, start);
  const rest = message === '' ? stack.slice(start) : stack.slice(start + message.length);
  if (header.includes('\n') || !rest.startsWith('\n')) return undefined;
  const lines = rest.slice(1).split('\n');
  return frameLocation(lines[0] ?? '') === undefined ? undefined : lines;
}

/**
 * The stack of an error as frame locations only, or undefined. Fails closed: the error's message is cut out of the stack, every kept line
 * must be a strict frame line (function names are dropped, a line that does not match is dropped, never trimmed), and anything unexpected
 * (a message changed after construction, a stack replaced by text, a getter that throws) gives no stack at all.
 * At most 6 frames and 1500 characters, so a request that fails over and over cannot write long lines.
 */
export function safeStack(error: unknown): string | undefined {
  let message: unknown;
  let stack: unknown;
  try {
    if (!(error instanceof Error)) return undefined;
    message = error.message;
    stack = error.stack;
  } catch {
    return undefined;
  }
  if (typeof message !== 'string' || typeof stack !== 'string') return undefined;
  const kept: string[] = [];
  let length = 0;
  for (const line of linesAfterHeader(stack, message) ?? []) {
    const location = frameLocation(line);
    if (location === undefined) continue;
    const frame = `    at ${location}`;
    if (kept.length === MAX_STACK_FRAMES || length + frame.length + 1 > MAX_STACK_CHARACTERS) break;
    kept.push(frame);
    length += frame.length + 1;
  }
  return kept.length === 0 ? undefined : kept.join('\n');
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

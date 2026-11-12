import { errorCode } from '../logger';

/** A database failure that means "not reachable right now". `code` is safe to log: a SQLSTATE, an errno code or one of the fixed codes below. */
export interface DatabaseFailure {
  readonly unavailable: true;
  readonly code: string;
}

/** How many errors along the `cause` chain are examined, the error itself included. This also stops a cyclic chain. */
const MAX_CHAIN = 5;

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['57P01', '57P03', '57014', 'ECONNREFUSED', 'ECONNRESET']);
/** SQLSTATE class 08, connection exception: five characters starting 08. */
const CONNECTION_CLASS = /^08[0-9A-Z]{3}$/;

/**
 * The pg driver (8.23.1) raises these errors with no `code`, so the whole message is the only signal. They are compared by equality,
 * never by "contains", and never copied into any output: the log gets the fixed code on the right. The outage tests run the real driver
 * into each of them, so a driver upgrade that rewords one fails the build instead of turning an outage into a 500.
 */
const DRIVER_TEXTS: ReadonlyMap<string, string> = new Map([
  ['timeout exceeded when trying to connect', 'POOL_TIMEOUT'],
  ['Connection terminated due to connection timeout', 'CONNECT_TIMEOUT'],
  ['Query read timeout', 'QUERY_TIMEOUT'],
  ['Connection terminated unexpectedly', 'CONNECTION_LOST'],
]);

function hasClientStatus(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return false;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

function classifyByCode(error: object): DatabaseFailure | undefined {
  const code = errorCode(error);
  return UNAVAILABLE_CODES.has(code) || CONNECTION_CLASS.test(code) ? { unavailable: true, code } : undefined;
}

/** A driver-raised timeout or lost connection. Only an Error with no string `code` and no `severity` qualifies: a pg server error always has both. */
function classifyByDriverText(error: object): DatabaseFailure | undefined {
  if (!(error instanceof Error) || 'severity' in error) return undefined;
  if ('code' in error && typeof error.code === 'string') return undefined;
  const fixedCode = DRIVER_TEXTS.get(error.message);
  return fixedCode === undefined ? undefined : { unavailable: true, code: fixedCode };
}

function causeOf(error: object): unknown {
  return 'cause' in error ? error.cause : undefined;
}

/**
 * Decides whether an error means the database cannot be reached: SQLSTATE 57P01, 57P03, 57014 and class 08, the errno codes ECONNREFUSED
 * and ECONNRESET, and the four driver timeout texts. Drizzle wraps the driver error in `cause`, so the chain is walked.
 * Any other error, including every other SQLSTATE, answers undefined and ends in the generic 500.
 *
 * Never reads `AggregateError.errors` (Node fills it with addresses) and never throws: a hostile getter ends the search with undefined.
 * An error that carries a 4xx `statusCode` is a client error (ECONNRESET is also how Node reports an aborted request body), never an outage.
 */
export function classifyDatabaseFailure(error: unknown): DatabaseFailure | undefined {
  try {
    if (hasClientStatus(error)) return undefined;
    let current: unknown = error;
    for (let examined = 0; examined < MAX_CHAIN; examined += 1) {
      if (typeof current !== 'object' || current === null) return undefined;
      const found = classifyByCode(current) ?? classifyByDriverText(current);
      if (found !== undefined) return found;
      current = causeOf(current);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

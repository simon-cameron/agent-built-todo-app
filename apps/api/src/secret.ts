import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * Holds a value that must never reach a log line, an error message or a test diff.
 * Every way of turning it into text yields "[redacted]"; only reveal() returns the value.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw value. Call it only where it is handed to the database driver. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

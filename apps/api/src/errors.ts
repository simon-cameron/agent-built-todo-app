/** A failure with a message that is safe to print as is; the process exits with code 1. */
export class StartupError extends Error {
  readonly exitCode = 1;
}

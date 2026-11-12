import { formatProblems, loadConfig } from './config';
import { createLogger, errorCode } from './logger';
import { StartupError } from './errors';
import { handleSignals, start, type SignalSource, type StartOptions } from './start';

export const FATAL_MESSAGE = 'The API stopped because of an unexpected error.';

/**
 * The only text printed for an unexpected failure: one fixed sentence and a safe code.
 * Never the message, stack or any property of the error, because pg and Drizzle errors carry SQL and parameters.
 */
export function fatalLine(error: unknown): string {
  return `${FATAL_MESSAGE} (code: ${errorCode(error)})\n`;
}

export interface ProcessEvents {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

export function installFatalHandlers(events: ProcessEvents, write: (text: string) => void, exit: (code: number) => void): void {
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    events.on(event, (reason) => {
      write(fatalLine(reason));
      exit(1);
    });
  }
}

export interface MainDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writeError: (text: string) => void;
  readonly exit: (code: number) => void;
  readonly signals: SignalSource;
  /** Lets tests replace the pool, probe, migrate or buildApp; production passes nothing. */
  readonly startOverrides?: Partial<StartOptions>;
  readonly logger?: ReturnType<typeof createLogger>;
}

/** Validates the config, starts the API and wires shutdown. Every failure ends in exit(1) with safe text only. */
export async function runMain(dependencies: MainDependencies): Promise<void> {
  const { env, writeError, exit, signals } = dependencies;
  try {
    const result = loadConfig(env);
    if (!result.ok) {
      writeError(formatProblems(result.problems));
      exit(1);
      return;
    }
    const logger = dependencies.logger ?? createLogger();
    const running = await start({ ...dependencies.startOverrides, config: result.config, logger });
    handleSignals(running, { signals, exit, logger });
  } catch (error) {
    writeError(error instanceof StartupError ? `${error.message}\n` : fatalLine(error));
    exit(1);
  }
}

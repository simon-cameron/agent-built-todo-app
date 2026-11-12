import { createLogger } from '../src/logger';

export interface LogRecord {
  readonly level: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

/** A real logger writing into memory, so tests can inspect every line that would reach stdout. */
export function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: string[]; records: () => LogRecord[] } {
  const lines: string[] = [];
  const logger = createLogger({
    write(chunk: string) {
      lines.push(...chunk.split('\n').filter((line) => line !== ''));
    },
  });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line) as LogRecord) };
}

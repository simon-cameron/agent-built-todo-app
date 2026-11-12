import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = resolve(apiRoot, 'node_modules', '.bin', 'tsx');

/** Each output stream keeps at most this many characters, so a log flood in a failing run cannot fill memory. */
const OUTPUT_LIMIT = 256 * 1024;

export interface BoundedChild {
  stdout(): string;
  stderr(): string;
  /** True once the child has exited. */
  hasExited(): boolean;
  /** Resolves with the exit code, or null when the child was killed by a signal. */
  readonly exited: Promise<number | null>;
  /** Asks the child to stop (SIGTERM goes to the tsx wrapper, which passes it on to the API). */
  terminate(): void;
  /** Kills the child and everything it started. Safe to call after it exited. */
  killGroup(): void;
}

/**
 * Runs a TypeScript entry under tsx as its own process group, with exactly the environment given (never the parent's)
 * and bounded output. Always call killGroup() in a finally.
 */
export function spawnTsx(args: readonly string[], env: Readonly<Record<string, string>>): BoundedChild {
  const child = spawn(tsx, [...args], { cwd: apiRoot, env: { ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out = (out + chunk.toString()).slice(-OUTPUT_LIMIT);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    err = (err + chunk.toString()).slice(-OUTPUT_LIMIT);
  });
  let done = false;
  const exited = new Promise<number | null>((resolveExit) =>
    child.once('exit', (code) => {
      done = true;
      resolveExit(code);
    }),
  );
  return {
    hasExited: () => done,
    stdout: () => out,
    stderr: () => err,
    exited,
    terminate: () => void child.kill('SIGTERM'),
    killGroup: () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    },
  };
}

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runs `git check-ignore` and returns its exit status (0 ignored, 1 not ignored). */
function checkIgnore(path: string): number | null {
  return spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status;
}

function isTracked(path: string): boolean {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', path], { cwd: root });
  return result.status === 0;
}

describe('.gitignore rules', () => {
  // Directory rules need a trailing slash so git treats a non-existent path as a directory.
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    '.env.test',
    'apps/api/.env',
    'node_modules/',
    'apps/web/node_modules/',
    'playwright-report/',
    'test-results/',
    'blob-report/',
    'playwright/.cache/',
    'coverage/',
    'dist/',
    'pgdata/',
    'tsconfig.tsbuildinfo',
  ])('ignores %s', (path) => {
    expect(checkIgnore(path)).toBe(0);
  });

  it('does not ignore .env.example', () => {
    expect(checkIgnore('.env.example')).toBe(1);
  });

  it('does not ignore the lockfile or workspace file', () => {
    expect(checkIgnore('pnpm-lock.yaml')).toBe(1);
    expect(checkIgnore('pnpm-workspace.yaml')).toBe(1);
  });

  it('tracks .env.example', () => {
    expect(isTracked('.env.example')).toBe(true);
  });

  it('tracks .gitignore itself', () => {
    expect(isTracked('.gitignore')).toBe(true);
  });
});

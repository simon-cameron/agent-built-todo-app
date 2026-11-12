import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_FOLDERS = ['apps', 'packages', 'tooling'];
const ALLOWED_FILES = new Set(['apps/api/test/db-setup.ts', 'tooling/test/sql-safety.test.ts']);
const SKIPPED_FOLDERS = new Set(['node_modules', 'fixtures']);
const DESTRUCTIVE = /\bTRUNCATE\b|\bDROP\s+(TABLE|DATABASE|SCHEMA|ROLE|USER|INDEX|VIEW|TYPE|SEQUENCE|OWNED)\b|\bCREATE\s+DATABASE\b/i;

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx|mjs|js|sql)$/.test(entry.name) ? [path] : [];
  });
}

describe('destructive SQL stays in the test harness', () => {
  it('appears in no file except db-setup.ts', () => {
    const offenders = SCANNED_FOLDERS.flatMap((folder) => sourceFiles(resolve(root, folder)))
      .map((path) => relative(root, path))
      .filter((path) => !ALLOWED_FILES.has(path))
      .filter((path) => DESTRUCTIVE.test(readFileSync(resolve(root, path), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the migration SQL contains none of it', () => {
    expect(readFileSync(resolve(root, 'apps/api/drizzle/0000_init.sql'), 'utf8')).not.toMatch(DESTRUCTIVE);
  });

  it('the pattern really matches what it must catch', () => {
    for (const sample of ['TRUNCATE todos', 'truncate  x', 'DROP DATABASE x', 'drop table y', 'CREATE DATABASE z']) {
      expect(DESTRUCTIVE.test(sample), sample).toBe(true);
    }
  });

  it('no package script runs a destructive drizzle-kit command', () => {
    const manifests = ['package.json', 'apps/api/package.json', 'apps/web/package.json', 'packages/shared/package.json'];
    for (const manifest of manifests) {
      const { scripts = {} } = JSON.parse(readFileSync(resolve(root, manifest), 'utf8')) as { scripts?: Record<string, string> };
      for (const [name, command] of Object.entries(scripts)) {
        expect(command, `${manifest} ${name}`).not.toMatch(/drizzle-kit\s+(push|drop|studio|migrate)\b/);
      }
      expect(Object.keys(scripts).filter((name) => /^db:(push|drop|migrate|studio)$/.test(name)), manifest).toEqual([]);
    }
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filesMatching, sourceFiles } from './source-scan';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWED_FILES = new Set(['apps/api/test/db-setup.ts', 'tooling/test/sql-safety.test.ts']);
const DESTRUCTIVE = /\bTRUNCATE\b|\bDROP\s+(TABLE|DATABASE|SCHEMA|ROLE|USER|INDEX|VIEW|TYPE|SEQUENCE|OWNED)\b|\bCREATE\s+DATABASE\b/i;

describe('destructive SQL stays in the test harness', () => {
  it('appears in no file except db-setup.ts', () => {
    expect(filesMatching(root, DESTRUCTIVE, ALLOWED_FILES)).toEqual([]);
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

  it('scans fixtures folders outside the lint fixtures, and every source extension', () => {
    const scratch = mkdtempSync(resolve(tmpdir(), 'sql-scan-'));
    try {
      for (const file of ['apps/x/test/fixtures/a.ts', 'apps/x/src/b.cjs', 'apps/x/src/c.mts', 'packages/y/src/d.cts', 'tooling/fixtures/lint/skipped.ts']) {
        mkdirSync(dirname(resolve(scratch, file)), { recursive: true });
        writeFileSync(resolve(scratch, file), 'TRUNCATE things;\n');
      }
      mkdirSync(resolve(scratch, 'apps/x/node_modules/z'), { recursive: true });
      writeFileSync(resolve(scratch, 'apps/x/node_modules/z/e.js'), 'TRUNCATE things;\n');
      expect(filesMatching(scratch, DESTRUCTIVE).sort()).toEqual(['apps/x/src/b.cjs', 'apps/x/src/c.mts', 'apps/x/test/fixtures/a.ts', 'packages/y/src/d.cts']);
      expect(sourceFiles(scratch, resolve(scratch, 'tooling')).sort()).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCANNED_FOLDERS, filesMatching, sourceFiles } from './source-scan';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVEAL_CALL = /\.reveal\(/;
/** The only source files that may hand the raw secret to something else. */
const ALLOWED_SOURCES = new Set(['apps/api/src/db/pool.ts', 'apps/api/src/secret.ts']);
const inSrcFolder = (path: string): boolean => /^(apps|packages)\/[^/]+\/src\//.test(path);

/** Files that call .reveal( where only the allowed ones may: any src file, plus anything under tooling/ except tests. */
function revealOffenders(base: string): string[] {
  const isTest = (path: string): boolean => /(^|\/)test\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path);
  return filesMatching(base, REVEAL_CALL, ALLOWED_SOURCES).filter((path) => (inSrcFolder(path) || path.startsWith('tooling/')) && !isTest(path));
}

describe('Secret.reveal() stays in two files', () => {
  it('is called in source only by src/db/pool.ts and src/secret.ts, and nowhere under tooling/', () => {
    expect(revealOffenders(root)).toEqual([]);
  });

  it('keeps the allow-list current: both files exist and pool.ts still calls it', () => {
    const present = SCANNED_FOLDERS.flatMap((folder) => sourceFiles(root, resolve(root, folder))).filter((path) => ALLOWED_SOURCES.has(path));
    expect(present.sort()).toEqual([...ALLOWED_SOURCES].sort());
    expect(filesMatching(root, REVEAL_CALL)).toContain('apps/api/src/db/pool.ts');
  });

  it('flags a throwaway src file and a tooling file, and ignores a test file', () => {
    const scratch = mkdtempSync(resolve(tmpdir(), 'reveal-scan-'));
    try {
      for (const file of ['apps/x/src/leak.ts', 'packages/y/src/nested/leak.mts', 'tooling/script.ts', 'apps/x/test/ok.test.ts']) {
        mkdirSync(dirname(resolve(scratch, file)), { recursive: true });
        writeFileSync(resolve(scratch, file), 'const v = secret.reveal();\n');
      }
      expect(revealOffenders(scratch).sort()).toEqual(['apps/x/src/leak.ts', 'packages/y/src/nested/leak.mts', 'tooling/script.ts']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

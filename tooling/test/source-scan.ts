import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/** Folders whose files are scanned by the repository guard tests. */
export const SCANNED_FOLDERS = ['apps', 'packages', 'tooling'] as const;
const SKIPPED_FOLDER_NAMES = new Set(['node_modules']);
/** Lint fixtures hold deliberately bad code, so this one folder is skipped; every other folder is scanned. */
const SKIPPED_PATHS = new Set(['tooling/fixtures/lint']);
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sql)$/;

const posix = (path: string): string => path.split(sep).join('/');

/** Every source file below `folder` (absolute), relative to `root` in the result, skipping node_modules and the lint fixtures. */
export function sourceFiles(root: string, folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_FOLDER_NAMES.has(entry.name) || SKIPPED_PATHS.has(posix(relative(root, path)))) return [];
      return sourceFiles(root, path);
    }
    return SOURCE_FILE.test(entry.name) ? [posix(relative(root, path))] : [];
  });
}

/** Files (root-relative, forward slashes) under the scanned folders whose text matches `pattern`, minus `allowed`. */
export function filesMatching(root: string, pattern: RegExp, allowed: ReadonlySet<string> = new Set()): string[] {
  return SCANNED_FOLDERS.flatMap((folder) => sourceFiles(root, resolve(root, folder)))
    .filter((path) => !allowed.has(path))
    .filter((path) => pattern.test(readFileSync(resolve(root, path), 'utf8')));
}

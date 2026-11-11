import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

interface PackageJson {
  packageManager?: string;
  engines?: { node?: string };
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
const readPkg = (rel: string): PackageJson => JSON.parse(read(rel)) as PackageJson;

const packagePaths = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
];

const EXACT = /^\d+\.\d+\.\d+$/;
const ALLOWED_NON_EXACT = /^(catalog:|workspace:\*)$/;

describe('workspace pins', () => {
  it('pins Node to major 24 in .nvmrc and every engines field', () => {
    expect(read('.nvmrc').trim()).toBe('24');
    for (const rel of packagePaths) {
      expect(readPkg(rel).engines?.node, rel).toBe('^24');
    }
  });

  it('enables engine-strict and save-exact in .npmrc', () => {
    const npmrc = read('.npmrc');
    expect(npmrc).toMatch(/^engine-strict=true$/m);
    expect(npmrc).toMatch(/^save-exact=true$/m);
  });

  it('pins pnpm exactly', () => {
    expect(readPkg('package.json').packageManager).toBe('pnpm@11.6.0');
  });

  it('uses exact versions in the catalog and only catalog or workspace references in packages', () => {
    const yaml = read('pnpm-workspace.yaml');
    const catalog = /^catalog:\n((?:[ ]{2}.+\n)+)/m.exec(yaml);
    expect(catalog).not.toBeNull();
    const entries = (catalog?.[1] ?? '').split('\n').filter((l) => l.trim() !== '');
    expect(entries.length).toBeGreaterThan(0);
    for (const line of entries) {
      const version = line.split(':').slice(1).join(':').trim();
      expect(version, line).toMatch(EXACT);
    }
    for (const rel of packagePaths) {
      const pkg = readPkg(rel);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, spec] of Object.entries(deps)) {
        expect(spec, `${rel} ${name}`).toMatch(ALLOWED_NON_EXACT);
      }
    }
  });

  it('points the shared package exports at source, with no build step', () => {
    const pkg = readPkg('packages/shared/package.json');
    expect(pkg.exports).toEqual({ '.': './src/index.ts' });
  });

  it('commits a lockfile', () => {
    expect(existsSync(resolve(root, 'pnpm-lock.yaml'))).toBe(true);
    const tracked = execFileSync('git', ['ls-files', 'pnpm-lock.yaml'], { cwd: root, encoding: 'utf8' });
    expect(tracked.trim()).toBe('pnpm-lock.yaml');
  });

  it('keeps the install-script allow-list equal to the expected (empty) list', () => {
    const yaml = read('pnpm-workspace.yaml');
    const expected: string[] = [];
    const block = /^allowBuilds:(.*)$/m.exec(yaml);
    expect(block).not.toBeNull();
    if (expected.length === 0) {
      expect(block?.[1]?.trim()).toBe('{}');
    }
  });
});

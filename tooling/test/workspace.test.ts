import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
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

/** The pnpm lockfile does not record install scripts, so the installed packages are inspected instead. */
function packagesWithInstallScripts(): Set<string> {
  const store = resolve(root, 'node_modules', '.pnpm');
  const found = new Set<string>();
  for (const folder of readdirSync(store)) {
    const modules = resolve(store, folder, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const entry of readdirSync(modules)) {
      const candidates = entry.startsWith('@') ? readdirSync(resolve(modules, entry)).map((name) => resolve(modules, entry, name)) : [resolve(modules, entry)];
      for (const dir of candidates) {
        const manifest = resolve(dir, 'package.json');
        if (!existsSync(manifest)) continue;
        const { name, scripts } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; scripts?: Record<string, string> };
        const hasScript = Boolean(scripts?.['preinstall'] ?? scripts?.['install'] ?? scripts?.['postinstall']);
        if (name !== undefined && (hasScript || existsSync(resolve(dir, 'binding.gyp')))) found.add(name);
      }
    }
  }
  return found;
}

function readAllowBuilds(): Record<string, boolean> {
  const { allowBuilds } = parse(read('pnpm-workspace.yaml')) as { allowBuilds?: Record<string, boolean> };
  return allowBuilds ?? {};
}

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

  it('has an explicit allowBuilds decision for every installed package with an install script, and no stale entry', () => {
    const decisions = readAllowBuilds();
    const withScripts = packagesWithInstallScripts();
    expect([...withScripts].sort()).toEqual(Object.keys(decisions).sort());
  });

  it('allows install scripts only for the packages listed here', () => {
    const allowed = Object.entries(readAllowBuilds())
      .filter(([, decision]) => decision)
      .map(([name]) => name);
    const expected: string[] = [];
    expect(allowed.sort()).toEqual(expected);
  });

  it('has no pg-native, and only registry packages with integrity hashes, in the lockfile', () => {
    const lock = parse(read('pnpm-lock.yaml')) as { packages?: Record<string, { resolution?: Record<string, unknown> }> };
    const packages = Object.entries(lock.packages ?? {});
    expect(packages.length).toBeGreaterThan(0);
    for (const [key, entry] of packages) {
      expect(key.startsWith('pg-native@'), key).toBe(false);
      expect(typeof entry.resolution?.['integrity'], key).toBe('string');
      expect(entry.resolution?.['tarball'], key).toBeUndefined();
      expect(entry.resolution?.['type'], key).toBeUndefined();
    }
  });

  it('keeps the 7 day release cooling-off and only exact-version exclusions', () => {
    const yaml = read('pnpm-workspace.yaml');
    expect(yaml).toMatch(/^minimumReleaseAge: 10080$/m);
    const excluded = /^minimumReleaseAgeExclude:\n((?:[ ]{2}- .+\n?)+)/m.exec(yaml);
    for (const line of (excluded?.[1] ?? '').split('\n').filter((l) => l.trim() !== '')) {
      expect(line, line).toMatch(/^ {2}- '(@[a-z0-9-]+\/)?[a-z0-9.-]+@\d+\.\d+\.\d+'$/);
    }
  });
});

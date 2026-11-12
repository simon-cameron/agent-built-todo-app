import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FATAL_MESSAGE } from '../src/fatal';
import { buildTestConfig } from './db-setup';
import { freePort } from './free-port';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = resolve(apiRoot, 'node_modules', '.bin', 'tsx');
const baseEnv = { PATH: process.env['PATH'] ?? '' };

describe('the real process', () => {
  it('names the bad variables, exits 1 and leaks no value when the configuration is invalid', () => {
    const marker = randomBytes(24).toString('hex');
    const result = spawnSync(tsx, ['src/index.ts'], { cwd: apiRoot, env: { ...baseEnv, DB_PASSWORD: marker, DB_HOST: marker }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DB_HOST');
    expect(result.stderr).toContain('DB_USER');
    expect(result.stderr).toContain('DB_NAME');
    expect(result.stdout + result.stderr).not.toContain(marker);
  });

  it('starts, answers /health and exits 0 on SIGTERM', async () => {
    const config = buildTestConfig();
    const port = await freePort();
    const child = spawn(tsx, ['src/index.ts'], {
      cwd: apiRoot,
      env: { ...baseEnv, DB_USER: config.dbUser, DB_PASSWORD: config.dbPassword.reveal(), DB_NAME: config.dbName, DB_HOST: config.dbHost, DB_PORT: String(config.dbPort), API_PORT: String(port) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
    try {
      await expect.poll(() => stdout.includes('"msg":"listening"'), { timeout: 15_000, interval: 100 }).toBe(true);
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(stdout).toContain('"msg":"shutting down"');
      expect(stderr).toBe('');
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);

  it.each(['rejection', 'exception'])('prints only the fixed sentence for an unhandled %s', (mode) => {
    const marker = randomBytes(24).toString('hex');
    const result = spawnSync(tsx, ['test/fixtures/fatal-entry.ts', mode], { cwd: apiRoot, env: { ...baseEnv, MARKER: marker }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${FATAL_MESSAGE} (code: XX000)\n`);
    expect(result.stdout + result.stderr).not.toContain(marker);
  }, 30_000);
});

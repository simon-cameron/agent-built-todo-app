import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatProblems, loadConfig } from '../src/config';

const generated = (): string => randomBytes(24).toString('hex');

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { DB_USER: 'app_user', DB_PASSWORD: generated(), DB_NAME: 'app_db', ...overrides };
}

function problemsFor(overrides: Record<string, string | undefined>): string[] {
  const result = loadConfig(validEnv(overrides));
  return result.ok ? [] : result.problems.map((problem) => `${problem.variable} ${problem.reason}`);
}

describe('loadConfig with a valid environment', () => {
  it('applies the documented defaults and wraps the password', () => {
    const value = generated();
    const result = loadConfig({ DB_USER: 'app_user', DB_PASSWORD: value, DB_NAME: 'app_db' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ dbHost: '127.0.0.1', dbPort: 5432, dbUser: 'app_user', dbName: 'app_db', apiPort: 3001, webPort: 3000 });
    expect(result.config.dbPassword.reveal()).toBe(value);
  });

  it.each(['127.0.0.1', 'localhost'])('accepts DB_HOST %s', (dbHost) => {
    expect(problemsFor({ DB_HOST: dbHost })).toEqual([]);
  });

  it('accepts a password of exactly 16 characters and parses numeric ports', () => {
    const result = loadConfig(validEnv({ DB_PASSWORD: 'a'.repeat(16), DB_PORT: '5433', API_PORT: '4000', WEB_PORT: '65535' }));
    expect(result.ok && [result.config.dbPort, result.config.apiPort, result.config.webPort]).toEqual([5433, 4000, 65535]);
  });
});

describe('loadConfig password rules', () => {
  it.each([
    ['an empty password', '', 'DB_PASSWORD must not be empty'],
    ['the placeholder', 'change-me', 'DB_PASSWORD must not be the placeholder change-me'],
    ['the placeholder in other case with spaces', ' Change-Me ', 'DB_PASSWORD must not be the placeholder change-me'],
    ['15 characters', 'a'.repeat(15), 'DB_PASSWORD must be at least 16 characters'],
  ])('rejects %s', (_label, value, expected) => {
    expect(problemsFor({ DB_PASSWORD: value })).toEqual([expected]);
  });

  it('reports a missing password', () => {
    expect(problemsFor({ DB_PASSWORD: undefined })).toEqual(['DB_PASSWORD is required']);
  });
});

describe('loadConfig other variables', () => {
  it.each(['192.168.1.5', '0.0.0.0', '::1', '', 'LOCALHOST'])('rejects DB_HOST %j', (dbHost) => {
    expect(problemsFor({ DB_HOST: dbHost })).toEqual(['DB_HOST must be 127.0.0.1 or localhost']);
  });

  it.each(['DB_NAME', 'DB_USER'])('reports a missing %s', (variable) => {
    expect(problemsFor({ [variable]: undefined })).toEqual([`${variable} is required`]);
  });

  it.each([
    ['uppercase', 'Todo'],
    ['a newline', 'abc\nDROP'],
    ['a control character', 'abc\u0007'],
    ['a leading digit', '1abc'],
    ['64 characters', 'a'.repeat(64)],
    ['empty', ''],
  ])('rejects an identifier with %s', (_label, value) => {
    expect(problemsFor({ DB_NAME: value, DB_USER: value })).toEqual([
      expect.stringMatching(/^DB_USER must be 1 to 63 characters/),
      expect.stringMatching(/^DB_NAME must be 1 to 63 characters/),
    ]);
  });

  it('accepts a 63 character identifier', () => {
    expect(problemsFor({ DB_NAME: 'a'.repeat(63) })).toEqual([]);
  });

  it.each(['DB_PORT', 'API_PORT', 'WEB_PORT'])('rejects bad values for %s', (variable) => {
    for (const value of ['0', '70000', '3001.5', 'abc', '', '-1', '1e3']) {
      expect(problemsFor({ [variable]: value }), value).toEqual([`${variable} must be a whole number from 1 to 65535`]);
    }
  });
});

describe('loadConfig reporting', () => {
  it('reports every problem together in a fixed variable order', () => {
    const problems = problemsFor({ WEB_PORT: 'x', DB_NAME: undefined, DB_PASSWORD: 'short', DB_HOST: '10.0.0.1', DB_USER: undefined });
    expect(problems.map((line) => line.split(' ')[0])).toEqual(['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'WEB_PORT']);
  });

  it('never puts a received value in the formatted output', () => {
    const markers = Array.from({ length: 5 }, generated);
    const [host, port, user, name, webPort] = markers;
    const result = loadConfig({ DB_HOST: host, DB_PORT: port, DB_USER: user, DB_PASSWORD: markers.join(''), DB_NAME: name, WEB_PORT: webPort });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const output = formatProblems(result.problems);
    for (const marker of markers) expect(output).not.toContain(marker);
    expect(output).toContain('DB_HOST');
    expect(output).toContain('WEB_PORT');
  });

  it('never prints a password that is only too short', () => {
    const value = randomBytes(4).toString('hex');
    const result = loadConfig(validEnv({ DB_PASSWORD: value }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatProblems(result.problems)).not.toContain(value);
  });
});

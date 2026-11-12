import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

const section = (title: string): string => {
  const start = readme.indexOf(`## ${title}`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
};

describe('README', () => {
  it('has the sections in order', () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(['Prerequisites', 'Setup', 'Your data', 'Security', 'Troubleshooting']);
  });

  it('lists the setup commands in the right order, with the password set before the first compose up', () => {
    const setup = section('Setup');
    const steps = ['cp .env.example .env', 'chmod 600 .env', 'openssl rand -hex 24', 'DB_HOST=127.0.0.1', 'docker compose up -d --wait', 'pnpm install', 'pnpm --filter @todo/api dev', 'curl http://127.0.0.1:3001/health'];
    const positions = steps.map((step) => setup.indexOf(step));
    expect(positions.every((position) => position >= 0), steps.filter((_, index) => (positions[index] ?? -1) < 0).join(', ')).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(setup).toMatch(/before the first `docker compose up`/);
  });

  it('explains that down keeps todos and down -v deletes them', () => {
    const data = section('Your data');
    expect(data).toMatch(/`docker compose down`[^\n]*keeps your todos/);
    expect(data).toMatch(/`docker compose down -v`[^\n]*deletes/);
  });

  it('covers each failure the API or the tests can report', () => {
    const troubleshooting = section('Troubleshooting');
    for (const text of ['database unreachable at host:port after 31 attempts', 'about 30 seconds when the database refuses connections', 'docker compose up -d', 'does not match the one stored in the existing database volume', 'docker compose down -v', 'does not exist', 'DB_PORT', 'not found', 'todo_test', '_test', 'another `pnpm test`', 'race']) {
      expect(troubleshooting, text).toContain(text);
    }
  });

  it('explains what a database outage looks like and that no API restart is needed', () => {
    const troubleshooting = section('Troubleshooting');
    for (const text of ['503 `database_unavailable`', 'nothing needs restarting', 'within 30 seconds', 'with no API restart', 'docker compose up -d --wait', 'never database or connection details']) {
      expect(troubleshooting, text).toContain(text);
    }
  });

  it('gives the API URL as the literal address and port', () => {
    expect(section('Setup')).toContain('`http://127.0.0.1:3001`');
    expect(section('Setup')).toMatch(/not `localhost`/);
  });

  it('has a security section with the local-only warning, no authentication, binds and published ports', () => {
    const security = section('Security');
    for (const text of ['this machine only', 'no login', '`127.0.0.1`', 'publish a port without the `127.0.0.1:` prefix', 'docker-compose.yml']) {
      expect(security, text).toContain(text);
    }
  });

  it('explains why a foreign host name returns 403 and why a missing Origin is allowed', () => {
    const security = section('Security');
    expect(security).toMatch(/`host_not_allowed`/);
    expect(security).toMatch(/DNS rebinding/);
    expect(security).toMatch(/`origin_not_allowed`/);
    expect(security).toMatch(/no `Origin` is allowed on purpose/);
    expect(security).toMatch(/never send one/);
  });

  it('says which responses and log lines the guarantees cover, and documents check:exposure and its exit codes', () => {
    const security = section('Security');
    expect(security).toMatch(/Node rejects before the API sees it/);
    expect(security).toContain('`pnpm check:exposure`');
    expect(security).toContain('`--allow-unverified`');
    for (const code of ['1 means a port is exposed', '2 means a probe timed out', '3 means this machine has no LAN interface', '4 means nothing is listening']) {
      expect(security, code).toContain(code);
    }
  });

  it('has troubleshooting entries for a port in use, host_not_allowed, origin_not_allowed and check:exposure not running', () => {
    const troubleshooting = section('Troubleshooting');
    for (const text of ['is already in use', 'API_PORT', '403 `host_not_allowed`', '403 `origin_not_allowed`', 'NOT RUNNING', 'inconclusive']) {
      expect(troubleshooting, text).toContain(text);
    }
  });

  it('never contains a password-like value', () => {
    expect(readme).not.toMatch(/DB_PASSWORD=\S+/);
  });
});

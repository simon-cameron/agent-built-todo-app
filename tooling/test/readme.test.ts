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
    expect(headings).toEqual(['Prerequisites', 'Setup', 'Your data', 'Troubleshooting']);
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

  it('never contains a password-like value', () => {
    expect(readme).not.toMatch(/DB_PASSWORD=\S+/);
  });
});

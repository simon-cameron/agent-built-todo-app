import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lines = readFileSync(resolve(root, '.env.example'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));

const pairs = lines.map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)] as const;
});

const EXPECTED = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
  DB_USER: 'todo', // ADR-10 dev role name
  DB_PASSWORD: 'change-me',
  DB_NAME: 'todo', // ADR-10 dev database name
  API_PORT: '3001',
  WEB_PORT: '3000',
};

describe('.env.example', () => {
  it('lists exactly the seven keys, once each, in order', () => {
    expect(pairs.map(([key]) => key)).toEqual(Object.keys(EXPECTED));
  });

  it('holds the agreed placeholder values', () => {
    expect(Object.fromEntries(pairs)).toEqual(EXPECTED);
  });

  it('has no quotes or inline comments in values', () => {
    for (const [key, value] of pairs) {
      expect(value, key).toMatch(/^[A-Za-z0-9.-]+$/);
    }
  });

  it('uses a placeholder password that the API can refuse at startup', () => {
    expect(Object.fromEntries(pairs)['DB_PASSWORD']).toBe('change-me');
  });
});

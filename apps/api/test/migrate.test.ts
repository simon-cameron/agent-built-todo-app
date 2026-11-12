import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TITLE_MAX_LENGTH } from '@todo/shared';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate';
import { withScratchDatabase } from './db-setup';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('the initial migration', () => {
  it('creates the todos table once and a second run applies nothing', async () => {
    await withScratchDatabase(async (pool) => {
      expect((await pool.query("SELECT to_regclass('public.todos') AS name")).rows[0]).toEqual({ name: null });

      await runMigrations(pool);
      const describeTable = async () =>
        (
          await pool.query(
            `SELECT column_name, data_type, is_nullable, column_default, is_identity, identity_generation
             FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'todos' ORDER BY ordinal_position`,
          )
        ).rows;
      const columns = await describeTable();
      expect(columns).toEqual([
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_identity: 'YES', identity_generation: 'ALWAYS' },
        { column_name: 'title', data_type: 'text', is_nullable: 'NO', column_default: null, is_identity: 'NO', identity_generation: null },
        { column_name: 'done', data_type: 'boolean', is_nullable: 'NO', column_default: 'false', is_identity: 'NO', identity_generation: null },
        { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()', is_identity: 'NO', identity_generation: null },
      ]);

      await pool.query('INSERT INTO todos (title) VALUES ($1)', ['kept']);
      await runMigrations(pool);

      expect((await pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0]).toEqual({ n: 1 });
      expect(await describeTable()).toEqual(columns);
      expect((await pool.query('SELECT title FROM todos')).rows).toEqual([{ title: 'kept' }]);
    });
  });

  it('enforces the title length check by code points and leaves trimming to the app', async () => {
    await withScratchDatabase(async (pool) => {
      await runMigrations(pool);
      const insert = (title: string) => pool.query('INSERT INTO todos (title) VALUES ($1)', [title]);

      await expect(insert('')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('a'.repeat(TITLE_MAX_LENGTH + 1))).rejects.toMatchObject({ code: '23514' });
      await expect(insert('\u{1F600}'.repeat(TITLE_MAX_LENGTH))).resolves.toBeDefined();
      await expect(insert('  ')).resolves.toBeDefined();
    });
  });

  it('rejects an explicit id and fills the defaults for done and the creation time', async () => {
    await withScratchDatabase(async (pool) => {
      await runMigrations(pool);
      await expect(pool.query('INSERT INTO todos (id, title) VALUES (5, $1)', ['x'])).rejects.toMatchObject({ code: '428C9' });
      const { rows } = await pool.query('INSERT INTO todos (title) VALUES ($1) RETURNING done, created_at', ['x']);
      expect(rows[0]?.['done']).toBe(false);
      expect(rows[0]?.['created_at']).toBeInstanceOf(Date);
    });
  });
});

describe('the committed migration files', () => {
  const sha256 = (relative: string): string => createHash('sha256').update(readFileSync(resolve(apiRoot, relative))).digest('hex');

  it('are unchanged since they were generated (never edit them by hand; add a new migration)', () => {
    expect({
      sql: sha256('drizzle/0000_init.sql'),
      journal: sha256('drizzle/meta/_journal.json'),
      snapshot: sha256('drizzle/meta/0000_snapshot.json'),
    }).toEqual({
      sql: 'd50a0345bc06deadd853f9fcdd3ce1d181f23453786b5ce8ce2eb8bfa73cef1d',
      journal: 'cf2f0263b476544eb70a7cb52521858a9133a65d7d3fdec50ba24847247b5c08',
      snapshot: 'b66602c2b5a9dfb16ae30f12e6664de0fc65f8cb3e12f82dc4f2cc41e660acea',
    });
  });
});

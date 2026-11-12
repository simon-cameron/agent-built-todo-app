import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The 200 here must equal TITLE_MAX_LENGTH in @todo/shared; migrate.test.ts proves the two agree.
 * The CHECK is a backstop only: trimming is the app's job, so there is deliberately no trim check.
 */
export const todos = pgTable(
  'todos',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    title: text().notNull(),
    done: boolean().notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('todos_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 200`)],
);

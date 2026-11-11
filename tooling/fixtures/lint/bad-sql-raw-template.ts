import { sql } from 'drizzle-orm';

export const clause = (name: string) => sql.raw(`SELECT * FROM t WHERE name = '${name}'`);

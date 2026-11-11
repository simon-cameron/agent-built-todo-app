import { sql } from 'drizzle-orm';

export const clause = (name: string) => sql`SELECT * FROM t WHERE name = ${name}`;

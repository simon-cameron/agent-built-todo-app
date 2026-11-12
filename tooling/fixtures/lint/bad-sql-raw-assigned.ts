import { sql } from 'drizzle-orm';

const raw = sql.raw;

export const clause = (text: string) => raw(text);

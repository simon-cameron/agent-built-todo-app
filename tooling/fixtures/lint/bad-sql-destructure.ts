import { sql } from 'drizzle-orm';

const { raw } = sql;

export const clause = (text: string) => raw(text);

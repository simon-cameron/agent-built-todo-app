import { sql } from 'drizzle-orm';

export const clause = (name: 'raw', text: string) => sql[name](text);

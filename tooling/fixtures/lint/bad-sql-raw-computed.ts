import { sql } from 'drizzle-orm';

export const clause = (text: string) => sql['raw'](text);

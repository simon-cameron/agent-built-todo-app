import { sql as other } from 'drizzle-orm';

export const clause = (text: string) => other.raw(text);

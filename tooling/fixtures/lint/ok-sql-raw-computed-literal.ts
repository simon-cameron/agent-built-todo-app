import { sql } from 'drizzle-orm';

export const clause = () => sql['raw']('now()');

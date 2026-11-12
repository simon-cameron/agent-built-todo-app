interface Client {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const text = 'SELECT * FROM t WHERE name = $1';

export const run = (client: Client, name: string) => client.query(text, [name]);

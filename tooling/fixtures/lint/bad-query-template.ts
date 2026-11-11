interface Client {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export const run = (client: Client, name: string) => client.query(`SELECT * FROM t WHERE name = '${name}'`);

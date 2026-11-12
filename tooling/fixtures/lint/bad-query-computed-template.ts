interface Client {
  query(text: string, values?: unknown[]): Promise<unknown>;
  [method: string]: unknown;
}

export const run = (client: Client, name: string) => client['query'](`SELECT ${name}`);

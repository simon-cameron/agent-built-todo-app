interface Client {
  query(text: string, values?: unknown[]): Promise<unknown>;
  [method: string]: unknown;
}

export const run = (client: Client, a: string, b: string) => client.query(a.concat(b), [1]);

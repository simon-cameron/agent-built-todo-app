interface Client {
  query(text: string, values?: unknown[]): Promise<unknown>;
  [method: string]: unknown;
}

export const run = (client: Client, text: string) => client.query(text);

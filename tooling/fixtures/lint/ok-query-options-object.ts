interface Client {
  query(text: string, values?: unknown[]): Promise<unknown>;
  [method: string]: unknown;
}

export const run = (client: Client) => client.query({ text: 'SELECT 1', values: [] });

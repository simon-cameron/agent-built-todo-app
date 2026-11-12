import { request, type IncomingHttpHeaders } from 'node:http';

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface RawRequestOptions {
  readonly port: number;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A real HTTP request to 127.0.0.1. Node sets Host to 127.0.0.1:<port> unless the headers say otherwise. */
export function rawRequest({ port, method = 'GET', path = '/', headers = {}, body }: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolveResponse, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

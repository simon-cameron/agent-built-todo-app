import { request, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildTestConfig } from './db-setup';

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

/** Sends raw bytes to 127.0.0.1:<port> and returns everything the server wrote until it closed the connection. */
export function rawSocket(port: number, text: string): Promise<string> {
  return new Promise((resolveText, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(text));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.once('error', reject);
    socket.once('close', () => resolveText(received));
  });
}

/** The status code of the first line of a raw HTTP response. */
export function statusOf(rawResponse: string): number {
  return Number(/^HTTP\/1\.[01] (\d{3})/.exec(rawResponse)?.[1] ?? 0);
}

/** The JSON body of a raw HTTP response, or undefined when it has none. */
export function bodyOf(rawResponse: string): unknown {
  const body = rawResponse.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  const json = /\{.*\}/s.exec(body)?.[0];
  return json === undefined ? undefined : JSON.parse(json);
}

/** The Host value `app.inject` must send so the Host check accepts it. */
export function localHost(port: number = buildTestConfig().apiPort): string {
  return `127.0.0.1:${port}`;
}

/** `app.inject` with a Host header the allowlist accepts, unless the options give one. */
export function injectLocal(app: FastifyInstance, options: InjectOptions & { url: string }): Promise<LightMyRequestResponse> {
  return app.inject({ ...options, headers: { host: localHost(), ...options.headers } });
}

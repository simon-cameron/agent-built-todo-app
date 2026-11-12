import { connect, createServer, type Server, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startDbProxy, type DbProxy } from './db-proxy';

/** The helper carries the database login in the outage tests, so a bug in it must not be able to pass as an app result: it is tested alone, against an echo server. */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function echoServer(): Promise<{ port: number; connections: () => number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolveListen) => server.listen({ host: '127.0.0.1', port: 0 }, resolveListen));
  closers.push(
    () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolveClose());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No port.');
  return { port: address.port, connections: () => sockets.length, sockets };
}

async function proxyTo(port: number): Promise<DbProxy> {
  const proxy = await startDbProxy({ host: '127.0.0.1', port });
  closers.push(() => proxy.close());
  return proxy;
}

/** A client socket with every error swallowed and its close state recorded. */
function client(port: number): { socket: Socket; received: () => string; closed: () => boolean; ready: Promise<void> } {
  let received = '';
  let closed = false;
  const socket = connect({ host: '127.0.0.1', port });
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => (received += chunk));
  socket.on('error', () => undefined);
  socket.on('close', () => (closed = true));
  closers.push(async () => void socket.destroy());
  const ready = new Promise<void>((resolveReady) => socket.once('connect', resolveReady));
  return { socket, received: () => received, closed: () => closed, ready };
}

/** Resolves with the error code of a connection attempt, or 'connected'. */
function attempt(port: number): Promise<string> {
  return new Promise((resolveAttempt) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveAttempt('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolveAttempt(error.code ?? 'error'));
  });
}

const pause = (ms: number): Promise<void> => new Promise((resolvePause) => setTimeout(resolvePause, ms));

describe('the test proxy', () => {
  it('passes bytes through to the target in both directions', async () => {
    const echo = await echoServer();
    const proxy = await proxyTo(echo.port);
    const c = client(proxy.port);
    await c.ready;
    c.socket.write('ping');
    await expect.poll(c.received).toBe('ping');
    expect(proxy.mode()).toBe('pass');
    expect(proxy.accepted()).toBe(1);
  });

  it('refuses a target that is not loopback, and accepts 127.0.0.1 and localhost', async () => {
    for (const host of ['192.168.1.5', '0.0.0.0', '::1', 'example.com', '']) {
      await expect(startDbProxy({ host, port: 5432 }), host).rejects.toThrow('loopback');
    }
    for (const host of ['127.0.0.1', 'localhost']) {
      const proxy = await startDbProxy({ host, port: 5432 });
      closers.push(() => proxy.close());
    }
  });

  it('listens on 127.0.0.1 only: its own non-loopback address does not reach it', async () => {
    const echo = await echoServer();
    const proxy = await proxyTo(echo.port);
    const external = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal);
    if (external === undefined) return;
    const outcome = await new Promise<string>((resolveOutcome) => {
      const socket = connect({ host: external.address, port: proxy.port, timeout: 1500 });
      socket.once('connect', () => resolveOutcome('connected'));
      socket.once('timeout', () => resolveOutcome('timeout'));
      socket.once('error', (error: NodeJS.ErrnoException) => resolveOutcome(error.code ?? 'error'));
      closers.push(async () => void socket.destroy());
    });
    expect(outcome).not.toBe('connected');
  });

  it('cut refuses new connections and destroys established sockets on both sides, without an unhandled error', async () => {
    const echo = await echoServer();
    const proxy = await proxyTo(echo.port);
    const c = client(proxy.port);
    await c.ready;
    c.socket.write('x');
    await expect.poll(c.received).toBe('x');
    proxy.cut();
    expect(proxy.mode()).toBe('cut');
    await expect.poll(c.closed).toBe(true);
    await expect.poll(() => echo.sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(await attempt(proxy.port)).toBe('ECONNREFUSED');
  });

  it('blackhole accepts new connections and answers nothing, and drops the bytes of an established one', async () => {
    const echo = await echoServer();
    const proxy = await proxyTo(echo.port);
    const established = client(proxy.port);
    await established.ready;
    // The proxy and the target both see the connection a moment after the client does.
    await expect.poll(() => proxy.accepted() + echo.connections()).toBe(2);
    proxy.blackhole();
    expect(proxy.mode()).toBe('blackhole');
    const held = client(proxy.port);
    await held.ready;
    await expect.poll(proxy.accepted).toBe(2);
    established.socket.write('lost');
    held.socket.write('lost');
    await pause(300);
    expect(established.received()).toBe('');
    expect(held.received()).toBe('');
    expect(established.closed()).toBe(false);
    expect(held.closed()).toBe(false);
    expect(echo.connections()).toBe(1);
    expect(proxy.accepted()).toBe(2);
  });

  it('restore after cut listens again on the same port and passes traffic', async () => {
    const echo = await echoServer();
    const proxy = await proxyTo(echo.port);
    const { port } = proxy;
    proxy.cut();
    expect(await attempt(port)).toBe('ECONNREFUSED');
    await proxy.restore();
    expect(proxy.port).toBe(port);
    expect(proxy.mode()).toBe('pass');
    const c = client(port);
    await c.ready;
    c.socket.write('back');
    await expect.poll(c.received).toBe('back');
  });

  it('restore after blackhole destroys the held sockets and passes traffic', async () => {
    const echo = await echoServer();
    const proxy = await proxyTo(echo.port);
    proxy.blackhole();
    const held = client(proxy.port);
    await held.ready;
    await expect.poll(proxy.accepted).toBe(1);
    await proxy.restore();
    await expect.poll(held.closed).toBe(true);
    const fresh = client(proxy.port);
    await fresh.ready;
    fresh.socket.write('ok');
    await expect.poll(fresh.received).toBe('ok');
  });

  it('close destroys everything, stops listening, and may be called twice', async () => {
    const echo = await echoServer();
    const proxy = await proxyTo(echo.port);
    const c = client(proxy.port);
    await c.ready;
    await proxy.close();
    await proxy.close();
    await expect.poll(c.closed).toBe(true);
    expect(await attempt(proxy.port)).toBe('ECONNREFUSED');
    await expect(proxy.restore()).rejects.toThrow('closed');
  });
});

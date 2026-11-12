import { connect, createServer, type Server, type Socket } from 'node:net';

/*
 * A loopback-only TCP proxy in front of the test database, so outage tests can cut and restore the connection without Docker.
 * The database login exchange crosses it, so it keeps no traffic, prints nothing and refuses any target that is not loopback.
 */

export type ProxyMode = 'pass' | 'cut' | 'blackhole';

export interface DbProxyTarget {
  readonly host: string;
  readonly port: number;
}

export interface DbProxy {
  /** The loopback port clients connect to. It never changes, so restore() brings the same address back. */
  readonly port: number;
  mode(): ProxyMode;
  /** Connections the listener accepted, held ones included; a refused connection is not counted. */
  accepted(): number;
  /** Refuses new connections and destroys every established socket, on both sides. */
  cut(): void;
  /** Keeps accepting but never answers: new connections are held without an upstream, established ones drop all bytes both ways. */
  blackhole(): void;
  /** Destroys held sockets, listens again on the same port if it was cut, and passes traffic through. */
  restore(): Promise<void>;
  /** Destroys everything and stops listening. Safe to call twice. */
  close(): Promise<void>;
}

const LOOPBACK_TARGETS: readonly string[] = ['127.0.0.1', 'localhost'];
const RELISTEN_ATTEMPTS = 20;
const RELISTEN_DELAY_MS = 100;

const ignoreSocketError = (): void => undefined;
const pause = (ms: number): Promise<void> => new Promise((resolvePause) => setTimeout(resolvePause, ms));

function listenOn(port: number, onConnection: (client: Socket) => void): Promise<Server> {
  return new Promise((resolveListen, reject) => {
    const server = createServer(onConnection);
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', reject);
      resolveListen(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

/**
 * Starts the proxy on a port the system picks. Rejects for a target host other than 127.0.0.1 or localhost.
 * Every socket it creates or destroys has an error listener, so cutting a connection cannot raise an unhandled error in the test worker.
 */
export async function startDbProxy(target: DbProxyTarget): Promise<DbProxy> {
  if (!LOOPBACK_TARGETS.includes(target.host)) throw new Error('The test proxy forwards to loopback only (127.0.0.1 or localhost).');

  let mode: ProxyMode = 'pass';
  let accepted = 0;
  let closed = false;
  let server: Server | undefined;
  let stopping: Promise<void> = Promise.resolve();
  const sockets = new Set<Socket>();

  const track = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.on('error', ignoreSocketError);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const destroyAll = (): void => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  const onConnection = (clientSocket: Socket): void => {
    accepted += 1;
    const client = track(clientSocket);
    if (mode === 'blackhole') {
      client.resume();
      return;
    }
    const upstream = track(connect({ host: target.host, port: target.port }));
    client.on('data', (chunk: Buffer) => {
      if (mode === 'pass') upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (mode === 'pass') client.write(chunk);
    });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  };

  server = await listenOn(0, onConnection);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test proxy did not get a port.');
  const { port } = address;

  async function relisten(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        server = await listenOn(port, onConnection);
        return;
      } catch (error) {
        if (attempt === RELISTEN_ATTEMPTS) throw new Error(`The test proxy could not listen again on port ${port}.`, { cause: error });
        await pause(RELISTEN_DELAY_MS);
      }
    }
  }

  return {
    port,
    mode: () => mode,
    accepted: () => accepted,
    cut() {
      mode = 'cut';
      if (server !== undefined) {
        stopping = closeServer(server);
        server = undefined;
      }
      destroyAll();
    },
    blackhole() {
      mode = 'blackhole';
    },
    async restore() {
      if (closed) throw new Error('The test proxy is closed.');
      await stopping;
      destroyAll();
      if (server === undefined) await relisten();
      mode = 'pass';
    },
    async close() {
      if (closed) return;
      closed = true;
      destroyAll();
      if (server !== undefined) {
        stopping = closeServer(server);
        server = undefined;
      }
      await stopping;
      destroyAll();
    },
  };
}

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool';
import { StartupError } from '../src/errors';
import { handleSignals, LISTEN_HOST, start, type RunningApp } from '../src/start';
import { buildTestConfig, silentLogger } from './db-setup';
import { freePort } from './free-port';
import { captureLogger } from './log-capture';

const running: RunningApp[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((instance) => instance.stop()));
});

async function startOnFreePort(overrides: Record<string, unknown> = {}) {
  const port = await freePort();
  const capture = captureLogger();
  const config = Object.assign({}, buildTestConfig(), { apiPort: port }, overrides);
  const instance = await start({ config, logger: capture.logger });
  running.push(instance);
  return { instance, port, capture };
}

describe('start', () => {
  it('binds 127.0.0.1 only and reports the address read back from the socket', async () => {
    const { instance, port, capture } = await startOnFreePort();
    expect(instance.app.server.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port });
    expect(instance.address).toEqual({ address: '127.0.0.1', port });
    expect(capture.records().find((record) => record.msg === 'listening')).toMatchObject({ address: '127.0.0.1', port });
  });

  it('cannot be moved off 127.0.0.1 by extra config fields or a HOST variable', async () => {
    process.env['HOST'] = '0.0.0.0';
    try {
      const { instance } = await startOnFreePort({ host: '0.0.0.0', listenHost: '0.0.0.0', apiHost: '0.0.0.0' });
      expect(instance.address.address).toBe(LISTEN_HOST);
      expect(LISTEN_HOST).toBe('127.0.0.1');
    } finally {
      delete process.env['HOST'];
    }
  });

  it('serves /health over a real socket after migrating', async () => {
    const { port, capture } = await startOnFreePort();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(capture.records().some((record) => record.msg === 'migrations applied' && typeof record['durationMs'] === 'number')).toBe(true);
  });

  it('stop closes the app and ends the pool, and may be called twice', async () => {
    const { instance, port } = await startOnFreePort();
    await instance.stop();
    await instance.stop();
    expect(instance.pool.ended).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('ends an injected pool too', async () => {
    const pool = createPool(buildTestConfig(), silentLogger);
    const port = await freePort();
    const instance = await start({ config: Object.assign({}, buildTestConfig(), { apiPort: port }), logger: captureLogger().logger, pool });
    expect(instance.pool).toBe(pool);
    await instance.stop();
    expect(pool.ended).toBe(true);
  });

  it('releases the pool and opens no socket when the migration fails', async () => {
    const pool = createPool(buildTestConfig(), silentLogger);
    const port = await freePort();
    const config = Object.assign({}, buildTestConfig(), { apiPort: port });
    await expect(
      start({
        config,
        logger: captureLogger().logger,
        pool,
        probe: async () => undefined,
        migrate: async () => {
          throw new Error('down');
        },
      }),
    ).rejects.toThrow('down');
    expect(pool.ended).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

function occupy(port: number): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveServer(server));
  });
}

describe('start when cleanup after a failed start fails', () => {
  it('logs one error line with a code and a fixed message, never the driver text, and still rejects with the original error', async () => {
    const secret = randomBytes(12).toString('hex');
    const capture = captureLogger();
    const stubPool = {
      end: async () => {
        throw Object.assign(new Error(`end failed ${secret}`), { code: 'XX000', detail: secret });
      },
    } as unknown as pg.Pool;
    const failure = start({
      config: Object.assign({}, buildTestConfig(), { apiPort: await freePort() }),
      logger: capture.logger,
      pool: stubPool,
      probe: async () => undefined,
      migrate: async () => {
        throw new StartupError('safe message');
      },
    });
    await expect(failure).rejects.toThrow('safe message');
    const lines = capture.records().filter((record) => record.msg === 'cleanup after failed start failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', err: { code: 'XX000', message: 'Cleanup after the failed start did not complete.' } });
    expect(capture.lines.join('\n')).not.toContain(secret);
  });
});

describe('start when the port is taken', () => {
  it('rejects with a StartupError naming the port and API_PORT, ends the pool and listens nowhere', async () => {
    const port = await freePort();
    const blocker = await occupy(port);
    try {
      const pool = createPool(buildTestConfig(), silentLogger);
      const config = Object.assign({}, buildTestConfig(), { apiPort: port });
      const failure = await start({ config, logger: captureLogger().logger, pool }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(StartupError);
      const message = (failure as StartupError).message;
      expect(message).toContain(`port ${port} is already in use`);
      expect(message).toContain('API_PORT');
      expect(pool.ended).toBe(true);
      expect(blocker.listening).toBe(true);
    } finally {
      blocker.close();
    }
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

describe('handleSignals', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('stops cleanly and exits 0 on %s', async (signal) => {
    const { instance } = await startOnFreePort();
    const signals = new EventEmitter();
    const exitCodes: number[] = [];
    const exited = new Promise<void>((resolveExit) => {
      handleSignals(instance, {
        signals,
        logger: captureLogger().logger,
        exit: (code) => {
          exitCodes.push(code);
          resolveExit();
        },
      });
    });
    signals.emit(signal);
    await exited;
    expect(exitCodes).toEqual([0]);
    expect((instance.pool as pg.Pool).ended).toBe(true);
  });

  it('exits 1 when stopping fails, logging a code and a fixed message and never the driver text', async () => {
    const secret = randomBytes(12).toString('hex');
    const capture = captureLogger();
    const signals = new EventEmitter();
    const exitCodes: number[] = [];
    const exited = new Promise<void>((resolveExit) => {
      handleSignals(
        { stop: () => Promise.reject(Object.assign(new Error(`nope ${secret}`), { code: 'XX000' })) },
        {
          signals,
          logger: capture.logger,
          exit: (code) => {
            exitCodes.push(code);
            resolveExit();
          },
        },
      );
    });
    signals.emit('SIGTERM');
    await exited;
    expect(exitCodes).toEqual([1]);
    expect(capture.records().find((record) => record.msg === 'shutdown failed')).toMatchObject({ level: 'error', err: { code: 'XX000', message: 'Shutdown did not complete cleanly.' } });
    expect(capture.lines.join('\n')).not.toContain(secret);
  });
});

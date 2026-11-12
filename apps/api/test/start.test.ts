import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool';
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

  it('exits 1 when stopping fails', async () => {
    const signals = new EventEmitter();
    const exitCodes: number[] = [];
    const exited = new Promise<void>((resolveExit) => {
      handleSignals(
        { stop: () => Promise.reject(new Error('nope')) },
        {
          signals,
          logger: captureLogger().logger,
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
  });
});

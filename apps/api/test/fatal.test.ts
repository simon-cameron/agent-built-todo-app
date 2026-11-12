import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { FATAL_MESSAGE, fatalLine, installFatalHandlers, runMain } from '../src/fatal';
import { StartupError } from '../src/errors';
import { buildTestConfig } from './db-setup';
import { freePort } from './free-port';
import { captureLogger } from './log-capture';

const generated = (): string => randomBytes(24).toString('hex');

function validEnv(extra: Record<string, string> = {}): Record<string, string> {
  const config = buildTestConfig();
  return { DB_USER: config.dbUser, DB_PASSWORD: config.dbPassword.reveal(), DB_NAME: config.dbName, DB_HOST: config.dbHost, DB_PORT: String(config.dbPort), ...extra };
}

function harness() {
  const errors: string[] = [];
  const exits: number[] = [];
  return { errors, exits, writeError: (text: string) => errors.push(text), exit: (code: number) => exits.push(code), signals: new EventEmitter(), capture: captureLogger() };
}

describe('runMain with an invalid configuration', () => {
  it('names the variables, exits 1 and never builds the app or listens', async () => {
    const buildApp = vi.fn();
    const probe = vi.fn();
    const marker = generated();
    const h = harness();
    await runMain({
      env: { DB_PASSWORD: marker, DB_HOST: '192.168.1.5' },
      writeError: h.writeError,
      exit: h.exit,
      signals: h.signals,
      logger: h.capture.logger,
      startOverrides: { buildApp, probe },
    });
    expect(h.exits).toEqual([1]);
    expect(buildApp).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(h.errors.join('')).toMatch(/DB_HOST/);
    expect(h.errors.join('')).toMatch(/DB_USER/);
    expect(h.errors.join('') + h.capture.lines.join('')).not.toContain(marker);
  });
});

describe('runMain when startup fails', () => {
  it('prints a StartupError message as is and exits 1', async () => {
    const h = harness();
    await runMain({
      env: validEnv(),
      writeError: h.writeError,
      exit: h.exit,
      signals: h.signals,
      logger: h.capture.logger,
      startOverrides: {
        probe: async () => undefined,
        migrate: async () => {
          throw new StartupError('safe message');
        },
      },
    });
    expect(h.errors).toEqual(['safe message\n']);
    expect(h.exits).toEqual([1]);
  });

  it('prints one fixed sentence and a code for an unexpected error from migrate or listen', async () => {
    const marker = generated();
    const leaky = () => Object.assign(new Error(`failed ${marker}`), { code: 'XX000', detail: marker, where: marker, query: marker, parameters: [marker] });
    const listenFails = {
      listen: async () => {
        throw leaky();
      },
      close: async () => undefined,
    } as unknown as FastifyInstance;
    const sites = {
      migrate: { probe: async () => undefined, migrate: async () => Promise.reject(leaky()) },
      listen: { probe: async () => undefined, migrate: async () => undefined, buildApp: () => listenFails },
    };
    for (const [site, overrides] of Object.entries(sites)) {
      const h = harness();
      await runMain({ env: validEnv({ API_PORT: String(await freePort()) }), writeError: h.writeError, exit: h.exit, signals: h.signals, logger: h.capture.logger, startOverrides: overrides });
      expect(h.errors, site).toEqual([`${FATAL_MESSAGE} (code: XX000)\n`]);
      expect(h.exits, site).toEqual([1]);
      expect(h.errors.join('') + h.capture.lines.join(''), site).not.toContain(marker);
    }
  });

  it('turns an unknown probe error into the unreachable message with no driver text', async () => {
    const marker = generated();
    const h = harness();
    await runMain({
      env: validEnv(),
      writeError: h.writeError,
      exit: h.exit,
      signals: h.signals,
      logger: h.capture.logger,
      startOverrides: {
        probe: async () => Promise.reject(Object.assign(new Error(`failed ${marker}`), { code: 'XX000', detail: marker, where: marker, query: marker })),
        waitMs: 2,
        intervalMs: 1,
        sleep: async () => undefined,
      },
    });
    expect(h.errors.join('')).toMatch(/database unreachable at/);
    expect(h.exits).toEqual([1]);
    expect(h.errors.join('') + h.capture.lines.join('')).not.toContain(marker);
  });
});

describe('fatalLine and installFatalHandlers', () => {
  it('uses the code only when it is short and plain', () => {
    expect(fatalLine(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(`${FATAL_MESSAGE} (code: ECONNREFUSED)\n`);
    expect(fatalLine(Object.assign(new Error('x'), { code: 'has spaces and a secret' }))).toBe(`${FATAL_MESSAGE} (code: unknown)\n`);
    expect(fatalLine('just a string')).toBe(`${FATAL_MESSAGE} (code: unknown)\n`);
  });

  it.each(['uncaughtException', 'unhandledRejection'] as const)('prints only the fixed sentence for %s and exits 1', (event) => {
    const marker = generated();
    const proc = new EventEmitter();
    const written: string[] = [];
    const exits: number[] = [];
    installFatalHandlers(proc, (text) => written.push(text), (code) => exits.push(code));
    proc.emit(event, Object.assign(new Error(marker), { detail: marker }));
    expect(written).toEqual([`${FATAL_MESSAGE} (code: unknown)\n`]);
    expect(exits).toEqual([1]);
  });
});

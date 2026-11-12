import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Secret } from '../src/secret';
import { createPool } from '../src/db/pool';
import { waitForDatabase, type DatabaseTarget } from '../src/db/wait';
import { StartupError } from '../src/errors';
import { start } from '../src/start';
import { buildTestConfig, silentLogger } from './db-setup';
import { freePort } from './free-port';
import { captureLogger } from './log-capture';

const generated = (): string => randomBytes(24).toString('hex');
const target: DatabaseTarget = { host: '127.0.0.1', port: 5432, user: 'app_user', database: 'app_db' };
const failWith = (code?: string, message = 'down') => async (): Promise<void> => {
  throw Object.assign(new Error(message), code === undefined ? {} : { code });
};

function setup(probe: () => Promise<void>, waitMs = 3, intervalMs = 1) {
  const capture = captureLogger();
  const sleep = vi.fn(async () => undefined);
  const probeSpy = vi.fn(probe);
  const run = () => waitForDatabase({ probe: probeSpy, target, logger: capture.logger, waitMs, intervalMs, sleep });
  return { capture, sleep, probeSpy, run };
}

async function failure(run: () => Promise<void>): Promise<StartupError> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(StartupError);
  return error as StartupError;
}

describe('when the database never answers', () => {
  it('makes floor(wait / interval) + 1 attempts, logs each, then fails with the unreachable message', async () => {
    const { capture, sleep, probeSpy, run } = setup(failWith('ECONNREFUSED'));
    const error = await failure(run);
    expect(probeSpy).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('database unreachable at 127.0.0.1:5432');
    expect(error.message).toContain('after 4 attempts');
    expect(error.message).toContain('docker compose up -d');
    const attempts = capture.records().filter((record) => record.msg === 'database not reachable yet');
    expect(attempts.map((record) => record['attempt'])).toEqual([1, 2, 3, 4]);
    expect(attempts[0]).toMatchObject({ level: 'warn', attempts: 4, host: '127.0.0.1', port: 5432, err: { code: 'ECONNREFUSED' } });
  });

  it('defaults to 31 attempts, one second apart, and words it as about 30 seconds when refused', async () => {
    const capture = captureLogger();
    const sleep = vi.fn(async () => undefined);
    const probe = vi.fn(failWith('ECONNREFUSED'));
    const error = await failure(() => waitForDatabase({ probe, target, logger: capture.logger, sleep }));
    expect(probe).toHaveBeenCalledTimes(31);
    expect(sleep).toHaveBeenCalledTimes(30);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(error.message).toContain('after 31 attempts (about 30 seconds when the database refuses connections)');
  });

  it('keeps retrying while the database is starting up (57P03) and on errors with no code', async () => {
    for (const code of ['57P03', undefined]) {
      const { probeSpy, run } = setup(failWith(code));
      await failure(run);
      expect(probeSpy, String(code)).toHaveBeenCalledTimes(4);
    }
  });

  it('never logs the driver message', async () => {
    const marker = generated();
    const { capture, run } = setup(failWith('XX000', `detail ${marker}`));
    const error = await failure(run);
    expect(error.message + capture.lines.join('\n')).not.toContain(marker);
  });
});

describe('when the database arrives later', () => {
  it('succeeds after three failures and logs the three attempts', async () => {
    let calls = 0;
    const { capture, probeSpy, run } = setup(async () => {
      calls += 1;
      if (calls <= 3) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    });
    await run();
    expect(probeSpy).toHaveBeenCalledTimes(4);
    expect(capture.records().filter((record) => record.msg === 'database not reachable yet')).toHaveLength(3);
  });

  it('lets start continue to migrate and listen', async () => {
    let calls = 0;
    const migrate = vi.fn(async () => undefined);
    const port = await freePort();
    const running = await start({
      config: Object.assign({}, buildTestConfig(), { apiPort: port }),
      logger: captureLogger().logger,
      probe: async () => {
        calls += 1;
        if (calls <= 3) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
      },
      migrate,
      waitMs: 10,
      intervalMs: 1,
      sleep: async () => undefined,
    });
    try {
      expect(calls).toBe(4);
      expect(migrate).toHaveBeenCalledTimes(1);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      await running.stop();
    }
  });
});

describe('when the database rejects the login', () => {
  it('stops at once on 28P01 with the volume hint, and never prints the password', async () => {
    const marker = generated();
    const { capture, sleep, probeSpy, run } = setup(failWith('28P01', `password authentication failed, password ${marker}`));
    const error = await failure(run);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error.message).toContain('does not match the one stored in the existing database volume');
    expect(error.message).toContain('docker compose down -v');
    expect(error.message).toContain('this deletes all todos');
    expect(error.message).toContain('Put the old DB_PASSWORD back to keep your data');
    expect(error.message).toContain('"app_user"');
    expect(error.message + capture.lines.join('\n')).not.toContain(marker);
  });

  it.each(['28000', '28P02', '28001'])('stops at once on %s with generic wording that does not blame the volume', async (code) => {
    const { sleep, probeSpy, run } = setup(failWith(code));
    const error = await failure(run);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error.message).toContain('rejected the login for user "app_user"');
    expect(error.message).toContain('Check DB_USER and DB_PASSWORD');
    expect(error.message).not.toMatch(/volume|down -v/);
  });

  it('stops at once on 3D000 with a hint about DB_NAME', async () => {
    const { sleep, probeSpy, run } = setup(failWith('3D000'));
    const error = await failure(run);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error.message).toContain('"app_db" does not exist');
    expect(error.message).toContain('Check DB_NAME');
  });
});

describe('a real wrong password against the test database', () => {
  it('is rejected by the driver with 28P01 and start fails fast without printing either password', async () => {
    const real = buildTestConfig();
    const marker = generated();
    const wrong = Object.assign({}, real, { dbPassword: new Secret(marker), apiPort: await freePort() });
    const capture = captureLogger();

    const probePool = createPool(wrong, silentLogger);
    const driverError = await probePool.query('SELECT 1').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    await probePool.end();
    expect(driverError).toMatchObject({ code: '28P01' });

    const sleep = vi.fn(async () => undefined);
    const pool = createPool(wrong, capture.logger);
    const error = await start({ config: wrong, logger: capture.logger, pool, sleep }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(StartupError);
    expect(sleep).not.toHaveBeenCalled();
    const output = `${(error as StartupError).message}\n${capture.lines.join('\n')}`;
    expect(output).not.toContain(marker);
    expect(output).not.toContain(real.dbPassword.reveal());
    expect((error as StartupError).message).toContain('docker compose down -v');
  });
});

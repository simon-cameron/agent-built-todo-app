import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT, classify, planProbes, probeConnect, readPorts, run, runCli, type Connect, type ConnectResult, type InterfaceMap, type PortSpec } from '../check-exposure';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORTS: readonly PortSpec[] = [
  { name: 'API_PORT', port: 3001 },
  { name: 'DB_PORT', port: 5432 },
];

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` });
const v6 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal, cidr: `${address}/64`, scopeid: 0 });
const LAN: InterfaceMap = { lo0: [v4('127.0.0.1', true), v6('::1', true)], en0: [v4('192.0.2.10'), v6('2001:db8::10'), v6('fe80::1')] };
const NO_LAN: InterfaceMap = { lo0: [v4('127.0.0.1', true), v6('::1', true)] };

/** A stub connect: loopback 127.0.0.1 listens unless `loopbackDown`, other addresses answer from `answers` or `fallback`. */
function stub(options: { answers?: Record<string, ConnectResult>; fallback?: ConnectResult; loopbackDown?: boolean } = {}): { connect: Connect; calls: string[] } {
  const calls: string[] = [];
  const connect: Connect = async (host, port) => {
    calls.push(`${host}:${port}`);
    if (host === '127.0.0.1') return options.loopbackDown === true ? 'refused' : 'connected';
    return options.answers?.[host] ?? options.fallback ?? 'refused';
  };
  return { connect, calls };
}

const go = (interfaces: InterfaceMap, double: ReturnType<typeof stub>, allowUnverified = false) => run({ interfaces, connect: double.connect, ports: PORTS, allowUnverified });

describe('planProbes', () => {
  it('lists every non-internal IPv4 and IPv6 address plus ::1, and no internal address', () => {
    const { targets, hasLanInterface } = planProbes(LAN);
    expect(hasLanInterface).toBe(true);
    expect(targets.map((target) => target.address)).toEqual(['192.0.2.10', '2001:db8::10', 'fe80::1%en0', '::1']);
    expect(targets.every((target) => target.address !== '127.0.0.1')).toBe(true);
  });

  it('gives a link-local IPv6 address its interface scope, and keeps an existing scope', () => {
    expect(planProbes({ utun3: [v6('fe80::abcd')] }).targets[0]).toEqual({ address: 'fe80::abcd%utun3', label: 'utun3' });
    expect(planProbes({ utun3: [v6('fe80::abcd%utun3')] }).targets[0]?.address).toBe('fe80::abcd%utun3');
  });

  it('always probes ::1, and reports a machine with no LAN address as having none', () => {
    const { targets, hasLanInterface } = planProbes(NO_LAN);
    expect(targets).toEqual([{ address: '::1', label: 'loopback-v6' }]);
    expect(hasLanInterface).toBe(false);
  });

  it('removes a repeated address', () => {
    expect(planProbes({ en0: [v4('192.0.2.10')], en1: [v4('192.0.2.10')] }).targets.filter((target) => target.address === '192.0.2.10')).toHaveLength(1);
  });
});

describe('classify', () => {
  it('passes only a refusal', () => {
    expect(classify('refused')).toBe('refused');
    expect(classify('connected')).toBe('exposed');
    expect(classify('timeout')).toBe('inconclusive');
    expect(classify('error')).toBe('inconclusive');
  });
});

describe('run: the outcomes', () => {
  it('exits 0 when every probe is refused', async () => {
    const result = await go(LAN, stub());
    expect(result.exitCode).toBe(EXIT.allRefused);
    expect(result.lines.at(-1)).toContain('every probe was refused');
  });

  it('exits 1 and says EXPOSED when an address accepts a connection', async () => {
    const result = await go(LAN, stub({ answers: { '192.0.2.10': 'connected' } }));
    expect(result.exitCode).toBe(EXIT.exposed);
    expect(result.lines.some((line) => line.startsWith('EXPOSED') && line.includes('192.0.2.10') && line.includes('API_PORT=3001'))).toBe(true);
  });

  it.each<ConnectResult>(['timeout', 'error'])('exits 2 for a probe that ends in %s, never as a pass', async (outcome) => {
    const result = await go(LAN, stub({ answers: { '2001:db8::10': outcome } }));
    expect(result.exitCode).toBe(EXIT.inconclusive);
    expect(result.lines.some((line) => line.startsWith('inconclusive') && line.includes('2001:db8::10'))).toBe(true);
  });

  it('exits 3 and says "not verified" when the machine has no LAN interface', async () => {
    const result = await go(NO_LAN, stub());
    expect(result.exitCode).toBe(EXIT.notVerified);
    expect(result.lines.join('\n')).toContain('not verified');
  });

  it('exits 0 with --allow-unverified for that case, while still printing "not verified"', async () => {
    const result = await go(NO_LAN, stub(), true);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toMatch(/not verified/);
  });

  it('exits 4 when nothing listens on 127.0.0.1, even with the flag, and says why', async () => {
    const result = await go(LAN, stub({ loopbackDown: true }), true);
    expect(result.exitCode).toBe(EXIT.notRunning);
    expect(result.lines.some((line) => line.startsWith('NOT RUNNING') && line.includes('API_PORT=3001'))).toBe(true);
  });

  it('notes that ::1 accepting a port means another program owns it', async () => {
    const result = await go(LAN, stub({ answers: { '::1': 'connected' } }));
    expect(result.exitCode).toBe(EXIT.exposed);
    expect(result.lines.some((line) => line.startsWith('note:') && line.includes('another program owns'))).toBe(true);
  });

  it('names the ports in use on the first line', async () => {
    const result = await run({ interfaces: LAN, connect: stub().connect, ports: [{ name: 'API_PORT', port: 3011 }, { name: 'DB_PORT', port: 5435 }], allowUnverified: false });
    expect(result.lines[0]).toBe('check:exposure: probing API_PORT=3011, DB_PORT=5435');
  });

  it('probes only literal IP addresses on every port, and 127.0.0.1 once per port for the running check', async () => {
    const double = stub();
    await go(LAN, double);
    expect(double.calls.every((call) => /^(127\.0\.0\.1|[0-9a-f:.%a-z]+):\d+$/.test(call))).toBe(true);
    expect(double.calls.some((call) => call.startsWith('localhost'))).toBe(false);
    for (const address of ['192.0.2.10', '2001:db8::10', 'fe80::1%en0', '::1']) {
      for (const port of [3001, 5432]) expect(double.calls).toContain(`${address}:${port}`);
    }
    expect(double.calls.filter((call) => call.startsWith('127.0.0.1:'))).toHaveLength(2);
  });

  it('treats a probe that never returns as inconclusive within the total bound', async () => {
    const never: Connect = (host) => (host === '127.0.0.1' ? Promise.resolve('connected') : new Promise(() => undefined));
    const result = await run({ interfaces: LAN, connect: never, ports: PORTS, allowUnverified: false, totalTimeoutMs: 30 });
    expect(result.exitCode).toBe(EXIT.inconclusive);
  });

  it('treats a connect function that throws as inconclusive', async () => {
    const throwing: Connect = async (host) => {
      if (host === '127.0.0.1') return 'connected';
      throw new Error('boom');
    };
    expect((await run({ interfaces: LAN, connect: throwing, ports: PORTS, allowUnverified: false })).exitCode).toBe(EXIT.inconclusive);
  });
});

describe('run: precedence of the worst finding', () => {
  it('exposed plus inconclusive gives 1', async () => {
    expect((await go(LAN, stub({ answers: { '192.0.2.10': 'connected', '2001:db8::10': 'timeout' } }))).exitCode).toBe(1);
  });

  it('exposed with the flag still gives 1', async () => {
    expect((await go(LAN, stub({ answers: { '192.0.2.10': 'connected' } }), true)).exitCode).toBe(1);
  });

  it('exposed plus not running gives 1', async () => {
    expect((await go(LAN, stub({ loopbackDown: true, answers: { '192.0.2.10': 'connected' } }))).exitCode).toBe(1);
  });

  it('inconclusive with the flag still gives 2', async () => {
    expect((await go(LAN, stub({ fallback: 'timeout' }), true)).exitCode).toBe(2);
  });

  it('not running plus inconclusive gives 4', async () => {
    expect((await go(LAN, stub({ loopbackDown: true, fallback: 'timeout' }))).exitCode).toBe(4);
  });

  it('not running plus not verified with the flag gives 4', async () => {
    expect((await go(NO_LAN, stub({ loopbackDown: true }), true)).exitCode).toBe(4);
  });

  it('not verified plus inconclusive (::1 timed out) gives 2, not 3', async () => {
    expect((await go(NO_LAN, stub({ answers: { '::1': 'timeout' } }))).exitCode).toBe(2);
  });
});

describe('readPorts', () => {
  it('uses 3001 and 5432 when nothing sets them', () => {
    expect(readPorts({}, undefined)).toEqual({ ok: true, ports: PORTS });
    expect(readPorts({}, 'DB_HOST=127.0.0.1\n')).toEqual({ ok: true, ports: PORTS });
  });

  it('reads both keys from .env text, tolerating export, quotes and comments', () => {
    expect(readPorts({}, 'API_PORT=3011\nDB_PORT=5435\n')).toEqual({ ok: true, ports: [{ name: 'API_PORT', port: 3011 }, { name: 'DB_PORT', port: 5435 }] });
    expect(readPorts({}, 'export API_PORT="3012"\nDB_PORT=5436 # local\n')).toEqual({ ok: true, ports: [{ name: 'API_PORT', port: 3012 }, { name: 'DB_PORT', port: 5436 }] });
  });

  it('lets the process environment beat .env', () => {
    expect(readPorts({ API_PORT: '4000' }, 'API_PORT=3011\nDB_PORT=5435\n')).toEqual({ ok: true, ports: [{ name: 'API_PORT', port: 4000 }, { name: 'DB_PORT', port: 5435 }] });
  });

  it.each(['abc', '', '0', '65536', '-1', '3001.5', ' 3001x', '0x10', '1e3'])('rejects %j and names only the variable', (value) => {
    expect(readPorts({ API_PORT: value }, undefined)).toEqual({ ok: false, variable: 'API_PORT' });
    expect(readPorts({}, `DB_PORT=${value}\n`)).toEqual({ ok: false, variable: 'DB_PORT' });
  });
});

describe('runCli', () => {
  function cli(options: { env?: Record<string, string | undefined>; envFile?: string; interfaces?: InterfaceMap; connect?: Connect; argv?: string[] }) {
    const out: string[] = [];
    const err: string[] = [];
    const promise = runCli({
      argv: options.argv ?? [],
      env: options.env ?? {},
      readEnvFile: () => options.envFile,
      interfaces: options.interfaces ?? LAN,
      connect: options.connect ?? stub().connect,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
    });
    return { promise, out, err };
  }

  it('probes the ports from .env and passes the flag through', async () => {
    const run1 = cli({ envFile: 'API_PORT=3011\nDB_PORT=5435\n', interfaces: NO_LAN, argv: ['--allow-unverified'] });
    expect(await run1.promise).toBe(0);
    expect(run1.out.join('')).toContain('probing API_PORT=3011, DB_PORT=5435');
  });

  it('prints a fixed sentence naming the variable, and exits 5, for a bad value; the value is never printed', async () => {
    const marker = randomBytes(12).toString('hex');
    const run1 = cli({ envFile: `API_PORT=${marker}\n` });
    expect(await run1.promise).toBe(EXIT.badSetting);
    expect(run1.err.join('')).toBe('check:exposure: API_PORT must be a whole number from 1 to 65535 (see .env).\n');
    expect(run1.out.join('') + run1.err.join('')).not.toContain(marker);
  });

  it('never prints a marker from any other .env line, such as the password', async () => {
    const marker = randomBytes(16).toString('hex');
    const envFile = `DB_USER=app\nDB_PASSWORD=${marker}\nSECRET_TOKEN=${marker}\nAPI_PORT=3011\nDB_PORT=5435\nAPI_PORT_EXTRA=${marker}\n`;
    const ok = cli({ envFile });
    expect(await ok.promise).toBe(0);
    expect(ok.out.join('') + ok.err.join('')).not.toContain(marker);
    const bad = cli({ envFile: `DB_PASSWORD=${marker}\nDB_PORT=not-a-port-${marker}\n` });
    await bad.promise;
    expect(bad.out.join('') + bad.err.join('')).not.toContain(marker);
  });

  it('ignores a key that only starts with API_PORT', () => {
    expect(readPorts({}, 'API_PORT_OLD=9\n')).toEqual({ ok: true, ports: PORTS });
  });
});

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('No port was assigned.'));
      else resolveServer({ server, port: address.port });
    });
  });
}

const closed = (server: Server): Promise<void> => new Promise((resolveClose) => server.close(() => resolveClose()));

describe('probeConnect over real sockets', () => {
  it('reports a listener as connected and a closed port as refused', async () => {
    const { server, port } = await listen('127.0.0.1');
    try {
      expect(await probeConnect('127.0.0.1', port, 1500)).toBe('connected');
    } finally {
      await closed(server);
    }
    expect(await probeConnect('127.0.0.1', port, 1500)).toBe('refused');
  });

  it('never reports an unreachable address as refused: a dropped connection is a timeout or an error', async () => {
    expect(['timeout', 'error']).toContain(await probeConnect('192.0.2.1', 9, 150));
  });
});

const lanV4 = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map(() => name));

describe('positive control: the check really sees an exposed port', () => {
  it.skipIf(lanV4.length === 0)('reports a throwaway 0.0.0.0 listener as exposed on this machine\'s own LAN address', async () => {
    const { server, port } = await listen('0.0.0.0');
    try {
      const result = await run({ interfaces: networkInterfaces(), connect: probeConnect, ports: [{ name: 'TEST_PORT', port }], allowUnverified: false });
      expect(result.exitCode).toBe(EXIT.exposed);
      expect(result.lines.some((line) => line.startsWith('EXPOSED'))).toBe(true);
    } finally {
      await closed(server);
    }
  }, 20_000);

  it('reports a loopback-only listener as not exposed on any other address of this machine', async () => {
    const { server, port } = await listen('127.0.0.1');
    try {
      const result = await run({ interfaces: networkInterfaces(), connect: probeConnect, ports: [{ name: 'TEST_PORT', port }], allowUnverified: true });
      expect(result.lines.some((line) => line.startsWith('EXPOSED'))).toBe(false);
      expect(result.lines.some((line) => line.startsWith('NOT RUNNING'))).toBe(false);
    } finally {
      await closed(server);
    }
  }, 20_000);
});

describe('the command', () => {
  it('is wired as the root check:exposure script and no longer a placeholder', () => {
    const result = spawnSync(process.execPath, ['-e', "const p=require('./package.json');process.stdout.write(p.scripts['check:exposure'])"], { cwd: root, encoding: 'utf8' });
    expect(result.stdout).toBe('tsx tooling/check-exposure.ts');
  });
});

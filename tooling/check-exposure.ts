import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * pnpm check:exposure: proves this machine's other addresses refuse the API and database ports.
 * It sends no bytes, reads only API_PORT and DB_PORT, and never prints an environment line or value.
 * Exit codes: 0 every probe refused; 1 exposed; 2 inconclusive; 3 not verified; 4 not running; 5 bad port setting.
 */

export interface PortSpec {
  readonly name: string;
  readonly port: number;
}

export type ConnectResult = 'refused' | 'connected' | 'timeout' | 'error';
export type Connect = (host: string, port: number, timeoutMs: number) => Promise<ConnectResult>;
export type Outcome = 'refused' | 'exposed' | 'inconclusive';
export type InterfaceMap = Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>;

export interface Target {
  /** A literal IP address; link-local IPv6 carries its %interface scope. Never a host name. */
  readonly address: string;
  /** The interface name, or "loopback-v6" for ::1. */
  readonly label: string;
}

export const EXIT = { allRefused: 0, exposed: 1, inconclusive: 2, notVerified: 3, notRunning: 4, badSetting: 5 } as const;
export const PROBE_TIMEOUT_MS = 1500;
export const TOTAL_TIMEOUT_MS = 10_000;
const LOOPBACK_V4 = '127.0.0.1';
const LOOPBACK_V6 = '::1';
const DIGITS = /^\d+$/;

/** The addresses to probe: every non-internal IPv4 and IPv6 address, plus ::1. Also says whether any LAN address exists. */
export function planProbes(interfaces: InterfaceMap): { readonly targets: readonly Target[]; readonly hasLanInterface: boolean } {
  const seen = new Set<string>();
  const lan: Target[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const address = entry.family === 'IPv6' && entry.address.toLowerCase().startsWith('fe80:') && !entry.address.includes('%') ? `${entry.address}%${name}` : entry.address;
      if (seen.has(address)) continue;
      seen.add(address);
      lan.push({ address, label: name });
    }
  }
  return { targets: [...lan, { address: LOOPBACK_V6, label: 'loopback-v6' }], hasLanInterface: lan.length > 0 };
}

/** Refused is the only pass; a completed connection is exposure; a timeout or any other error proves nothing. */
export function classify(result: ConnectResult): Outcome {
  if (result === 'refused') return 'refused';
  return result === 'connected' ? 'exposed' : 'inconclusive';
}

export interface RunInput {
  readonly interfaces: InterfaceMap;
  readonly connect: Connect;
  readonly ports: readonly PortSpec[];
  readonly allowUnverified: boolean;
  readonly probeTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export interface RunResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

function withDeadline(work: Promise<ConnectResult>, ms: number): Promise<ConnectResult> {
  return new Promise((resolveResult) => {
    const timer = setTimeout(() => resolveResult('timeout'), ms);
    void work.then(
      (result) => {
        clearTimeout(timer);
        resolveResult(result);
      },
      () => {
        clearTimeout(timer);
        resolveResult('error');
      },
    );
  });
}

/**
 * Probes every address on every port and reports the worst finding.
 * Precedence: exposed (1), then not running (4, never overridable), then inconclusive (2), then not verified (3).
 * `allowUnverified` turns only the last into 0, and the line still says "not verified".
 */
export async function run(input: RunInput): Promise<RunResult> {
  const { interfaces, connect: tryConnect, ports, allowUnverified } = input;
  const probeTimeout = input.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const totalTimeout = input.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const lines = [`check:exposure: probing ${ports.map(({ name, port }) => `${name}=${port}`).join(', ')}`];

  const running = await Promise.all(ports.map(async ({ name, port }) => ({ name, port, up: (await withDeadline(tryConnect(LOOPBACK_V4, port, probeTimeout), probeTimeout + 500)) === 'connected' })));
  for (const { name, port, up } of running) {
    lines.push(up ? `running      ${LOOPBACK_V4} ${name}=${port}: something accepts connections (the lsof output says which program)` : `NOT RUNNING  ${LOOPBACK_V4} ${name}=${port}: nothing accepts connections, so a refusal elsewhere would prove nothing`);
  }
  const notRunning = running.some(({ up }) => !up);

  const plan = planProbes(interfaces);
  const probes = plan.targets.flatMap((target) => ports.map((spec) => ({ target, spec })));
  const results = await Promise.all(probes.map(async ({ target, spec }) => ({ target, spec, outcome: classify(await withDeadline(tryConnect(target.address, spec.port, probeTimeout), totalTimeout)) })));
  for (const { target, spec, outcome } of results) {
    const word = outcome === 'refused' ? 'refused     ' : outcome === 'exposed' ? 'EXPOSED     ' : 'inconclusive';
    lines.push(`${word} ${target.label} ${target.address} ${spec.name}=${spec.port}`);
    if (outcome === 'exposed' && target.address === LOOPBACK_V6) {
      lines.push(`note: ${LOOPBACK_V6} accepted ${spec.name}=${spec.port}; another program owns that port on IPv6, because the API binds 127.0.0.1 only`);
    }
  }

  const exposed = results.some(({ outcome }) => outcome === 'exposed');
  const inconclusive = results.some(({ outcome }) => outcome === 'inconclusive');
  const notVerified = !plan.hasLanInterface;
  if (notVerified) lines.push('not verified: this machine has no LAN interface, so only ::1 was probed');

  let exitCode: number = EXIT.allRefused;
  let summary = 'every probe was refused';
  if (exposed) {
    exitCode = EXIT.exposed;
    summary = 'EXPOSED: an address other than 127.0.0.1 accepted a connection';
  } else if (notRunning) {
    exitCode = EXIT.notRunning;
    summary = 'not running: start the stack first';
  } else if (inconclusive) {
    exitCode = EXIT.inconclusive;
    summary = 'inconclusive: at least one probe timed out or failed in another way';
  } else if (notVerified) {
    exitCode = allowUnverified ? EXIT.allRefused : EXIT.notVerified;
    summary = allowUnverified ? 'not verified (allowed by --allow-unverified): only ::1 was probed' : 'not verified: pass --allow-unverified to accept a machine with no LAN interface';
  }
  lines.push(`result: ${summary} (exit ${exitCode})`);
  return { exitCode, lines };
}

export type PortsResult = { readonly ok: true; readonly ports: readonly PortSpec[] } | { readonly ok: false; readonly variable: string };

const SETTINGS = [
  { name: 'API_PORT', fallback: 3001 },
  { name: 'DB_PORT', fallback: 5432 },
] as const;

/** The value of one key in .env text, looking at lines that start with that key only; every other line is ignored unread. */
function valueFromEnvFile(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`).exec(line);
    if (match === null) continue;
    const raw = (match[1] ?? '').trim();
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    return quoted === null ? raw.replace(/\s+#.*$/, '') : (quoted[2] ?? '');
  }
  return undefined;
}

/**
 * API_PORT and DB_PORT from the process environment first, then .env text (the node --env-file precedence),
 * then 3001 and 5432. Only those two keys are read; any other .env line is never parsed.
 */
export function readPorts(env: Readonly<Record<string, string | undefined>>, envFileText: string | undefined): PortsResult {
  const ports: PortSpec[] = [];
  for (const { name, fallback } of SETTINGS) {
    const value = env[name] ?? (envFileText === undefined ? undefined : valueFromEnvFile(envFileText, name));
    if (value === undefined) {
      ports.push({ name, port: fallback });
    } else if (DIGITS.test(value) && Number(value) >= 1 && Number(value) <= 65535) {
      ports.push({ name, port: Number(value) });
    } else {
      return { ok: false, variable: name };
    }
  }
  return { ok: true, ports };
}

/** One real TCP connect, no bytes sent. ECONNREFUSED is "refused"; a completed handshake is "connected". */
export const probeConnect: Connect = (host, port, timeoutMs) =>
  new Promise((resolveResult) => {
    const socket = connect({ host, port });
    let finished = false;
    const finish = (result: ConnectResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolveResult(result);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('connected'));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? 'refused' : 'error'));
  });

export interface CliInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readEnvFile: () => string | undefined;
  readonly interfaces: InterfaceMap;
  readonly connect: Connect;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
}

/** The command-line wrapper without the process: testable with stubs. Returns the exit code. */
export async function runCli(input: CliInput): Promise<number> {
  const ports = readPorts(input.env, input.readEnvFile());
  if (!ports.ok) {
    input.writeErr(`check:exposure: ${ports.variable} must be a whole number from 1 to 65535 (see .env).\n`);
    return EXIT.badSetting;
  }
  const result = await run({ interfaces: input.interfaces, connect: input.connect, ports: ports.ports, allowUnverified: input.argv.includes('--allow-unverified') });
  input.writeOut(`${result.lines.join('\n')}\n`);
  return result.exitCode;
}

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');

function readRootEnvFile(): string | undefined {
  try {
    return readFileSync(envPath, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runCli({
    argv: process.argv.slice(2),
    env: process.env,
    readEnvFile: readRootEnvFile,
    interfaces: networkInterfaces(),
    connect: probeConnect,
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('check:exposure: stopped because of an unexpected error.\n');
      process.exitCode = EXIT.badSetting;
    },
  );
}

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Compose file names Docker prefers over, or merges into, docker-compose.yml. */
const OTHER_COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.yaml',
  'docker-compose.override.yml',
  'docker-compose.override.yaml',
];

const PUBLISHED_PORT = '127.0.0.1:${DB_PORT:-5432}:5432';
const DATA_PATH = '/var/lib/postgresql/data';
const VOLUME_NAME = 'todo_pgdata';
const PASSWORD_FROM_ENV = /^\$\{DB_PASSWORD:\?[^}]+\}$/;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function environmentOf(service: Json): Map<string, string> {
  const env = service['environment'];
  const entries = new Map<string, string>();
  if (Array.isArray(env)) {
    for (const item of env) {
      const text = String(item);
      const index = text.indexOf('=');
      entries.set(index === -1 ? text : text.slice(0, index), index === -1 ? '' : text.slice(index + 1));
    }
  } else {
    for (const [key, value] of Object.entries(asRecord(env))) entries.set(key, String(value ?? ''));
  }
  return entries;
}

function portProblems(ports: unknown): string[] {
  if (!Array.isArray(ports) || ports.length !== 1) return ['ports: exactly one published port is required'];
  const [entry] = ports;
  if (typeof entry === 'string') {
    return entry === PUBLISHED_PORT ? [] : [`ports: must be exactly ${PUBLISHED_PORT}`];
  }
  const long = asRecord(entry);
  const problems: string[] = [];
  if (long['host_ip'] !== '127.0.0.1') problems.push('ports: long syntax needs host_ip 127.0.0.1');
  if (long['target'] !== 5432) problems.push('ports: long syntax target must be 5432');
  if (long['published'] !== '${DB_PORT:-5432}') problems.push('ports: long syntax published must be ${DB_PORT:-5432}');
  return problems;
}

function volumeProblems(service: Json, topLevel: Json): string[] {
  const problems: string[] = [];
  const mounts = service['volumes'];
  const expected = `${VOLUME_NAME}:${DATA_PATH}`;
  if (!Array.isArray(mounts) || mounts.length !== 1 || mounts[0] !== expected) {
    problems.push(`volumes: the only mount must be the named volume ${expected}`);
  }
  const declared = topLevel[VOLUME_NAME];
  if (!(VOLUME_NAME in topLevel)) {
    problems.push(`volumes: top-level volume ${VOLUME_NAME} is missing`);
  } else if (declared !== null && Object.keys(asRecord(declared)).length > 0) {
    problems.push(`volumes: ${VOLUME_NAME} must have no name, external or driver options, so a clone never shares data`);
  }
  return problems;
}

/**
 * Returns one sentence per broken rule; an empty array means the compose document is acceptable.
 * Pure on purpose: the tests run it on the real file and on deliberately broken copies.
 */
export function checkCompose(document: unknown, filesPresent: readonly string[]): string[] {
  const problems: string[] = [];
  const doc = asRecord(document);
  const services = asRecord(doc['services']);
  const db = asRecord(services['db']);

  for (const file of filesPresent) {
    if (OTHER_COMPOSE_FILES.includes(file)) problems.push(`other compose file: ${file} would shadow or extend docker-compose.yml`);
  }
  if ('name' in doc) problems.push('name: a top-level name is not allowed, the project is named from the directory');
  if (Object.keys(services).join() !== 'db') problems.push('services: only the db service is allowed');

  for (const key of ['network_mode', 'env_file', 'container_name']) {
    if (key in db) problems.push(`${key}: not allowed`);
  }
  for (const key of ['command', 'entrypoint']) {
    if (/listen_addresses|pg_hba/.test(JSON.stringify(db[key] ?? ''))) problems.push(`${key}: must not override listen_addresses or pg_hba`);
  }
  if (typeof db['image'] !== 'string' || !db['image'].startsWith('postgres:17')) problems.push('image: must be postgres:17');

  const env = environmentOf(db);
  if (/trust/i.test(env.get('POSTGRES_HOST_AUTH_METHOD') ?? '')) problems.push('POSTGRES_HOST_AUTH_METHOD: trust auth is not allowed');
  if (/trust/i.test(env.get('POSTGRES_INITDB_ARGS') ?? '')) problems.push('POSTGRES_INITDB_ARGS: trust auth is not allowed');
  if (!PASSWORD_FROM_ENV.test(env.get('POSTGRES_PASSWORD') ?? '')) {
    problems.push('POSTGRES_PASSWORD: must be exactly ${DB_PASSWORD:?message}');
  }

  problems.push(...portProblems(db['ports']));

  const healthcheck = asRecord(db['healthcheck']);
  if (!Array.isArray(healthcheck['test'])) {
    problems.push('healthcheck: missing');
  } else if (!healthcheck['test'].some((part) => String(part).includes('pg_isready'))) {
    problems.push('healthcheck: must use pg_isready');
  }

  problems.push(...volumeProblems(db, asRecord(doc['volumes'])));
  return problems;
}

const realDocument = (): unknown => parse(readFileSync(resolve(root, 'docker-compose.yml'), 'utf8'));
const mutated = (change: (doc: Json, db: Json) => void): unknown => {
  const doc = realDocument() as Json;
  change(doc, asRecord(asRecord(doc['services'])['db']));
  return doc;
};
const setEnvironment = (db: Json, key: string, value: string): void => {
  const env = asRecord(db['environment']);
  env[key] = value;
  db['environment'] = env;
};

describe('docker-compose.yml', () => {
  it('passes every rule and no other compose file sits next to it', () => {
    const files = readdirSync(root);
    expect(files).toContain('docker-compose.yml');
    expect(checkCompose(realDocument(), files)).toEqual([]);
  });

  it('is a clean one-service file with the agreed values', () => {
    const doc = realDocument() as Json;
    const db = asRecord(asRecord(doc['services'])['db']);
    expect(db['ports']).toEqual([PUBLISHED_PORT]);
    expect(db['volumes']).toEqual([`${VOLUME_NAME}:${DATA_PATH}`]);
  });
});

describe('checkCompose must fail', () => {
  const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['a bare port', mutated((_d, db) => (db['ports'] = ['5432'])), /^ports:/],
    ['5432:5432', mutated((_d, db) => (db['ports'] = ['5432:5432'])), /^ports:/],
    ['0.0.0.0:5432:5432', mutated((_d, db) => (db['ports'] = ['0.0.0.0:5432:5432'])), /^ports:/],
    ['[::1]:5432:5432', mutated((_d, db) => (db['ports'] = ['[::1]:5432:5432'])), /^ports:/],
    ['localhost as the host side', mutated((_d, db) => (db['ports'] = ['localhost:${DB_PORT:-5432}:5432'])), /^ports:/],
    ['an interpolated host side', mutated((_d, db) => (db['ports'] = ['${DB_BIND:-127.0.0.1}:${DB_PORT:-5432}:5432'])), /^ports:/],
    ['another variable in the port', mutated((_d, db) => (db['ports'] = ['127.0.0.1:${OTHER:-5432}:5432'])), /^ports:/],
    ['two published ports', mutated((_d, db) => (db['ports'] = [PUBLISHED_PORT, '127.0.0.1:5999:5432'])), /^ports:/],
    ['long syntax without host_ip', mutated((_d, db) => (db['ports'] = [{ target: 5432, published: '${DB_PORT:-5432}' }])), /^ports: long syntax needs host_ip/],
    [
      'long syntax with 0.0.0.0',
      mutated((_d, db) => (db['ports'] = [{ target: 5432, published: '${DB_PORT:-5432}', host_ip: '0.0.0.0' }])),
      /^ports: long syntax needs host_ip/,
    ],
    ['network_mode host', mutated((_d, db) => (db['network_mode'] = 'host')), /^network_mode:/],
    ['trust auth as a map entry', mutated((_d, db) => setEnvironment(db, 'POSTGRES_HOST_AUTH_METHOD', 'trust')), /^POSTGRES_HOST_AUTH_METHOD:/],
    [
      'trust auth in list form',
      mutated((_d, db) => (db['environment'] = ['POSTGRES_PASSWORD=${DB_PASSWORD:?set it}', 'POSTGRES_HOST_AUTH_METHOD=trust'])),
      /^POSTGRES_HOST_AUTH_METHOD:/,
    ],
    ['trust in initdb args', mutated((_d, db) => setEnvironment(db, 'POSTGRES_INITDB_ARGS', '--auth-host=trust')), /^POSTGRES_INITDB_ARGS:/],
    ['a literal password', mutated((_d, db) => setEnvironment(db, 'POSTGRES_PASSWORD', 'literal-value')), /^POSTGRES_PASSWORD:/],
    ['a password with a default', mutated((_d, db) => setEnvironment(db, 'POSTGRES_PASSWORD', '${DB_PASSWORD:-x}')), /^POSTGRES_PASSWORD:/],
    ['a password without the :? guard', mutated((_d, db) => setEnvironment(db, 'POSTGRES_PASSWORD', '${DB_PASSWORD}')), /^POSTGRES_PASSWORD:/],
    ['env_file', mutated((_d, db) => (db['env_file'] = ['.env'])), /^env_file:/],
    ['container_name', mutated((_d, db) => (db['container_name'] = 'shared-db')), /^container_name:/],
    ['a top-level name', mutated((d) => (d['name'] = 'shared')), /^name:/],
    ['a command touching listen_addresses', mutated((_d, db) => (db['command'] = ['postgres', '-c', 'listen_addresses=*'])), /^command:/],
    ['an entrypoint touching pg_hba', mutated((_d, db) => (db['entrypoint'] = 'sh -c "echo host all all 0.0.0.0/0 trust >> pg_hba.conf"')), /^entrypoint:/],
    ['a missing healthcheck', mutated((_d, db) => delete db['healthcheck']), /^healthcheck: missing/],
    ['a healthcheck that is not pg_isready', mutated((_d, db) => (db['healthcheck'] = { test: ['CMD', 'true'] })), /^healthcheck: must use pg_isready/],
    ['a missing top-level volume', mutated((d) => delete d['volumes']), /^volumes: top-level/],
    ['a bind mount', mutated((_d, db) => (db['volumes'] = [`./pgdata:${DATA_PATH}`])), /^volumes: the only mount/],
    ['a wrong mount path', mutated((_d, db) => (db['volumes'] = [`${VOLUME_NAME}:/data`])), /^volumes: the only mount/],
    ['a volume with a fixed name', mutated((d) => (d['volumes'] = { [VOLUME_NAME]: { name: 'shared_pgdata' } })), /^volumes: todo_pgdata must have no name/],
    ['an external volume', mutated((d) => (d['volumes'] = { [VOLUME_NAME]: { external: true } })), /^volumes: todo_pgdata must have no name/],
    ['a second service', mutated((d) => ((d['services'] as Json)['extra'] = { image: 'busybox' })), /^services:/],
    ['another image', mutated((_d, db) => (db['image'] = 'mariadb:11')), /^image:/],
  ];

  it.each(cases)('rejects %s', (_label, document, rule) => {
    const problems = checkCompose(document, ['docker-compose.yml']);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => rule.test(problem)), problems.join(' | ')).toBe(true);
  });

  it.each(OTHER_COMPOSE_FILES)('rejects %s next to the compose file', (file) => {
    const problems = checkCompose(realDocument(), ['docker-compose.yml', file]);
    expect(problems.some((problem) => problem.startsWith('other compose file'))).toBe(true);
  });
});

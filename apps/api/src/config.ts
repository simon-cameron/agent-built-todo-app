import { z } from 'zod';
import { Secret } from './secret';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const MIN_PASSWORD_LENGTH = 16;
const PLACEHOLDER_PASSWORD = 'change-me';
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost'] as const;
const DIGITS = /^\d+$/;

/** Variable names in the order problems are reported. */
const VARIABLES = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'API_PORT', 'WEB_PORT'] as const;
type Variable = (typeof VARIABLES)[number];

export interface AppConfig {
  readonly dbHost: (typeof ALLOWED_HOSTS)[number];
  readonly dbPort: number;
  readonly dbUser: string;
  readonly dbPassword: Secret;
  readonly dbName: string;
  readonly apiPort: number;
  readonly webPort: number;
}

/** One offending variable. The reason is a fixed sentence and never contains the received value. */
export interface ConfigProblem {
  readonly variable: Variable;
  readonly reason: string;
}

export type ConfigResult = { readonly ok: true; readonly config: AppConfig } | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

type Environment = Readonly<Record<string, string | undefined>>;

const IDENTIFIER_REASON = 'must be 1 to 63 characters: lowercase letters, digits and underscores, not starting with a digit';
const REQUIRED_REASON = 'is required';

const identifier = z.string({ error: REQUIRED_REASON }).regex(IDENTIFIER, { error: IDENTIFIER_REASON });

const password = z.string({ error: REQUIRED_REASON }).superRefine((value, context) => {
  if (value === '') {
    context.addIssue({ code: 'custom', message: 'must not be empty' });
  } else if (value.trim().toLowerCase() === PLACEHOLDER_PASSWORD) {
    context.addIssue({ code: 'custom', message: `must not be the placeholder ${PLACEHOLDER_PASSWORD}` });
  } else if (value.length < MIN_PASSWORD_LENGTH) {
    context.addIssue({ code: 'custom', message: `must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
});

const host = z
  .string({ error: 'must be 127.0.0.1 or localhost' })
  .default('127.0.0.1')
  .refine((value): value is (typeof ALLOWED_HOSTS)[number] => (ALLOWED_HOSTS as readonly string[]).includes(value), {
    error: 'must be 127.0.0.1 or localhost',
  });

const port = (fallback: number) =>
  z
    .string({ error: 'must be a whole number from 1 to 65535' })
    .default(String(fallback))
    .refine((value) => DIGITS.test(value) && Number(value) >= 1 && Number(value) <= 65535, { error: 'must be a whole number from 1 to 65535' })
    .transform(Number);

const schema = z.object({
  DB_HOST: host,
  DB_PORT: port(5432),
  DB_USER: identifier,
  DB_PASSWORD: password,
  DB_NAME: identifier,
  API_PORT: port(3001),
  WEB_PORT: port(3000),
});

const isVariable = (name: unknown): name is Variable => (VARIABLES as readonly unknown[]).includes(name);

/**
 * Parses the environment once. Problems carry variable names and fixed reasons only,
 * so reporting them can never print a received value.
 */
export function loadConfig(env: Environment): ConfigResult {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const reasonByVariable = new Map<Variable, string>();
    for (const issue of parsed.error.issues) {
      const name = issue.path[0];
      if (isVariable(name) && !reasonByVariable.has(name)) reasonByVariable.set(name, issue.message);
    }
    const problems = VARIABLES.flatMap((variable) => {
      const reason = reasonByVariable.get(variable);
      return reason === undefined ? [] : [{ variable, reason }];
    });
    return { ok: false, problems };
  }
  const value = parsed.data;
  return {
    ok: true,
    config: {
      dbHost: value.DB_HOST,
      dbPort: value.DB_PORT,
      dbUser: value.DB_USER,
      dbPassword: new Secret(value.DB_PASSWORD),
      dbName: value.DB_NAME,
      apiPort: value.API_PORT,
      webPort: value.WEB_PORT,
    },
  };
}

/** Formats problems for stderr: one line per variable name and reason. */
export function formatProblems(problems: readonly ConfigProblem[]): string {
  const lines = problems.map((problem) => `  ${problem.variable} ${problem.reason}`);
  return ['The API cannot start: fix these settings in .env (see the README).', ...lines, ''].join('\n');
}

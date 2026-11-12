import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name: string): string => readFileSync(resolve(root, 'tooling/fixtures/lint', name), 'utf8');
const eslint = new ESLint({ cwd: root });

interface Finding {
  readonly ruleId: string | null;
  readonly message: string;
}

/** Lints a fixture as if it lived at `virtualPath` inside the repo. */
async function lintAs(virtualPath: string, name: string): Promise<Finding[]> {
  const [result] = await eslint.lintText(fixture(name), { filePath: resolve(root, virtualPath) });
  return (result?.messages ?? []).map((m) => ({ ruleId: m.ruleId, message: m.message }));
}

const WEB = 'apps/web/src/fixture.tsx';
const API = 'apps/api/src/fixture.ts';

describe('lint guard: must fail', () => {
  it('flags dangerouslySetInnerHTML in the web app with react/no-danger', async () => {
    const findings = await lintAs(WEB, 'bad-danger.tsx');
    expect(findings.map((f) => f.ruleId)).toContain('react/no-danger');
  });

  it.each([
    ['sql.raw with a template literal', 'bad-sql-raw-template.ts', /sql\.raw accepts a plain string literal only/],
    ['sql.raw with + concatenation', 'bad-sql-raw-concat.ts', /sql\.raw accepts a plain string literal only/],
    ['sql.raw with a variable', 'bad-sql-raw-variable.ts', /sql\.raw accepts a plain string literal only/],
    ['client.query with a ${} template', 'bad-query-template.ts', /template literal with \$\{\} to \.query\(\)/],
    ['client.query with + concatenation', 'bad-query-concat.ts', /Do not join strings with \+ to build \.query\(\)/],
    ['client.query with one variable argument', 'bad-query-variable.ts', /\.query\(\) with one argument must be/],
    ['client.query with one .concat() argument', 'bad-query-concat-call.ts', /\.query\(\) with one argument must be/],
    ['client.query with one String.raw argument', 'bad-query-string-raw.ts', /\.query\(\) with one argument must be/],
    ["client['query'] with one variable argument", 'bad-query-computed-variable.ts', /\.query\(\) with one argument must be/],
    ["client['query'] with a ${} template", 'bad-query-computed-template.ts', /template literal with \$\{\} to \.query\(\)/],
    ['client.query with .concat() text and values', 'bad-query-values-concat.ts', /Do not build \.query\(\) text with \.concat\(\)/],
    ['sql imported under another name', 'bad-sql-alias-import.ts', /Do not alias sql on import/],
    ['raw destructured out of sql', 'bad-sql-destructure.ts', /Do not destructure members out of sql/],
    ["sql['raw'] with a variable", 'bad-sql-raw-computed.ts', /sql\.raw accepts a plain string literal only/],
    ['sql.raw copied into another name', 'bad-sql-raw-assigned.ts', /Do not copy a member of sql/],
    ['a sql member looked up by a computed name', 'bad-sql-computed-name.ts', /computed name/],
  ])('flags %s in the api', async (_label, name, pattern) => {
    const findings = await lintAs(API, name);
    const hits = findings.filter((f) => f.ruleId === 'no-restricted-syntax');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toMatch(pattern);
  });

  it('flags the sql alias in the api even when the alias is only imported', async () => {
    const [result] = await eslint.lintText("import { sql as other } from 'drizzle-orm';\nexport const x = other;\n", { filePath: resolve(root, API) });
    expect(result?.messages.map((m) => m.ruleId)).toContain('no-restricted-syntax');
  });

  it('names the known bypasses in the rule message', async () => {
    const findings = await lintAs(API, 'bad-query-variable.ts');
    expect(findings[0]?.message).toContain('pool.query.bind(pool)');
    expect(findings[0]?.message).toContain('text built earlier and passed with a values array');
  });

  it('states the limits of the guard rail in the rule message', async () => {
    const findings = await lintAs(API, 'bad-sql-raw-variable.ts');
    expect(findings[0]?.message).toContain('cannot see every indirect way');
  });

  it('fails the real ESLint command line on the HTML fixture', () => {
    const result = spawnSync(
      resolve(root, 'node_modules/.bin/eslint'),
      ['--stdin', '--stdin-filename', 'apps/web/src/fixture.tsx'],
      { cwd: root, input: fixture('bad-danger.tsx'), encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('react/no-danger');
  });
});

describe('lint guard: must pass', () => {
  it('accepts a plain React element', async () => {
    expect(await lintAs(WEB, 'ok-plain-element.tsx')).toEqual([]);
  });

  it.each([
    ['a parameterised sql tagged template', 'ok-sql-tagged.ts'],
    ['sql.raw with a fixed string', 'ok-sql-raw-literal.ts'],
    ['client.query with a fixed string', 'ok-query-literal.ts'],
    ['client.query with text and values', 'ok-query-params.ts'],
    ["client['query'] with a fixed string", 'ok-query-computed-literal.ts'],
    ['client.query with an options object', 'ok-query-options-object.ts'],
    ['client.query with a template that has no ${}', 'ok-query-template-plain.ts'],
    ["sql['raw'] with a fixed string", 'ok-sql-raw-computed-literal.ts'],
  ])('accepts %s', async (_label, name) => {
    expect(await lintAs(API, name)).toEqual([]);
  });
});

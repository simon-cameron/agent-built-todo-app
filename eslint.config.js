import js from '@eslint/js';
import react from 'eslint-plugin-react';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SQL_GUARD_NOTE =
  'This guard rail cannot see every indirect way to build a query: pool.query.bind(pool), a destructured query, ' +
  'text built earlier and passed with a values array, or a wrapper around pg. ' +
  'Tagged sql templates with ${} are allowed because the driver binds them as parameters.';

/** A .query(...) call written as db.query(...) or db['query'](...), plus extra conditions on the call. */
const queryCall = (conditions) => [
  `CallExpression[callee.computed=false][callee.property.name='query']${conditions}`,
  `CallExpression[callee.computed=true][callee.property.value='query']${conditions}`,
];

const RAW_MESSAGE =
  'sql.raw accepts a plain string literal only. Do not build SQL from template literals, concatenation or variables; ' +
  'use a parameterised sql tagged template instead. ' +
  SQL_GUARD_NOTE;

const ONE_ARGUMENT_NOT_FIXED =
  ':not([arguments.0.type="Literal"]):not([arguments.0.type="ObjectExpression"]):not([arguments.0.type="TemplateLiteral"])' +
  ':not([arguments.0.type="BinaryExpression"][arguments.0.operator="+"])';

const sqlRestrictedSyntax = [
  { selector: "CallExpression[callee.computed=false][callee.object.name='sql'][callee.property.name='raw'][arguments.0.type!='Literal']", message: RAW_MESSAGE },
  { selector: "CallExpression[callee.computed=true][callee.object.name='sql'][callee.property.value='raw'][arguments.0.type!='Literal']", message: RAW_MESSAGE },
  {
    selector: "CallExpression[callee.computed=true][callee.object.name='sql'][callee.property.type!='Literal']",
    message: 'Do not look up a sql member with a computed name. ' + SQL_GUARD_NOTE,
  },
  {
    selector: "ImportSpecifier[imported.name='sql'][local.name!='sql']",
    message: 'Do not alias sql on import: the guard on sql.raw looks for the name sql. ' + SQL_GUARD_NOTE,
  },
  {
    selector: "VariableDeclarator[id.type='ObjectPattern'][init.name='sql']",
    message: 'Do not destructure members out of sql: the guard on sql.raw looks for the name sql. ' + SQL_GUARD_NOTE,
  },
  {
    selector: "VariableDeclarator[init.type='MemberExpression'][init.object.name='sql']",
    message: 'Do not copy a member of sql into another name: the guard on sql.raw looks for the name sql. ' + SQL_GUARD_NOTE,
  },
  ...queryCall("[arguments.0.type='TemplateLiteral'][arguments.0.expressions.length>0]").map((selector) => ({
    selector,
    message:
      'Do not pass a template literal with ${} to .query(). Pass a fixed SQL string and a values array so the driver binds parameters. ' +
      SQL_GUARD_NOTE,
  })),
  ...queryCall("[arguments.0.type='BinaryExpression'][arguments.0.operator='+']").map((selector) => ({
    selector,
    message:
      'Do not join strings with + to build .query() text. Pass a fixed SQL string and a values array so the driver binds parameters. ' +
      SQL_GUARD_NOTE,
  })),
  ...queryCall("[arguments.length>=2][arguments.0.type='CallExpression'][arguments.0.callee.property.name='concat']").map((selector) => ({
    selector,
    message:
      'Do not build .query() text with .concat(). Pass a fixed SQL string and a values array so the driver binds parameters. ' + SQL_GUARD_NOTE,
  })),
  ...queryCall(`[arguments.length=1]${ONE_ARGUMENT_NOT_FIXED}`).map((selector) => ({
    selector,
    message:
      '.query() with one argument must be a string literal, a template with no ${}, or an options object, never a variable or a built string. ' +
      'Pass a fixed SQL string and a values array so the driver binds parameters. ' +
      SQL_GUARD_NOTE,
  })),
];

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'tooling/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...sqlRestrictedSyntax] },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { react },
    rules: { 'react/no-danger': 'error' },
  },
);

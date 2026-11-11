import js from '@eslint/js';
import react from 'eslint-plugin-react';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SQL_GUARD_NOTE =
  'This guard rail cannot see every indirect way to build a query (for example an aliased sql.raw). ' +
  'Tagged sql templates with ${} are allowed because the driver binds them as parameters.';

const sqlRestrictedSyntax = [
  {
    selector: "CallExpression[callee.object.name='sql'][callee.property.name='raw'][arguments.0.type!='Literal']",
    message:
      'sql.raw accepts a plain string literal only. Do not build SQL from template literals, concatenation or variables; ' +
      'use a parameterised sql tagged template instead. ' +
      SQL_GUARD_NOTE,
  },
  {
    selector: "CallExpression[callee.property.name='query'][arguments.0.type='TemplateLiteral'][arguments.0.expressions.length>0]",
    message:
      'Do not pass a template literal with ${} to .query(). Pass a fixed SQL string and a values array so the driver binds parameters. ' +
      SQL_GUARD_NOTE,
  },
  {
    selector: "CallExpression[callee.property.name='query'][arguments.0.type='BinaryExpression'][arguments.0.operator='+']",
    message:
      'Do not join strings with + to build .query() text. Pass a fixed SQL string and a values array so the driver binds parameters. ' +
      SQL_GUARD_NOTE,
  },
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

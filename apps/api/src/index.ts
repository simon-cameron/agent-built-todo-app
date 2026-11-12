import { writeSync } from 'node:fs';
import { installFatalHandlers, runMain } from './fatal';

const writeError = (text: string): void => {
  writeSync(2, text);
};
const exit = (code: number): void => process.exit(code);

installFatalHandlers(process, writeError, exit);
void runMain({ env: process.env, writeError, exit, signals: process });

import { writeSync } from 'node:fs';
import { installFatalHandlers } from '../../src/fatal';

// Used by leak.test.ts: raises an error that carries the marker everywhere a driver error would.
const marker = process.env['MARKER'] ?? '';
const failure = Object.assign(new Error(`failed with ${marker}`), { code: 'XX000', detail: marker, where: marker, query: marker, parameters: [marker] });

installFatalHandlers(
  process,
  (text) => writeSync(2, text),
  (code) => process.exit(code),
);

if (process.argv[2] === 'rejection') {
  void Promise.reject(failure);
} else {
  setTimeout(() => {
    throw failure;
  }, 0);
}

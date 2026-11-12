import { safeStack } from '../../src/logger';

// Used by safe-stack.test.ts under real tsx, whose stack headers are built differently from Vitest's.
// Prints one JSON object: the stack of each marker case, or null when none is kept.
const marker = process.env['MARKER'] ?? '';

class Named extends Error {}
Named.prototype.name = `Named ${marker}`;

const original = new Error(`message ${marker}`);
const changed = new Error(`message ${marker}`);
// Read the stack first: the runtime may build it lazily from the current message.
void changed.stack;
changed.message = changed.message.slice(0, 10);

const cases: Record<string, Error> = {
  plain: new Error('plain'),
  marker: original,
  multiline: new Error(`first ${marker}\n    at /x:1:1)\nlast ${marker}`),
  named: new Named(`named ${marker}`),
  changed,
  empty: new Error(''),
};

const result: Record<string, string | null> = {};
for (const [name, error] of Object.entries(cases)) result[name] = safeStack(error) ?? null;
process.stdout.write(`${JSON.stringify(result)}\n`);

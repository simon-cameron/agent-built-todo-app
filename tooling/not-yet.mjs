// Placeholder for root scripts that a later ticket implements.
// Exits 1 on purpose so nobody mistakes a placeholder for a passing check.
const [name = 'unknown', ticket = '?'] = process.argv.slice(2);
process.stderr.write(`"${name}" is not implemented until ticket ${ticket}.\n`);
process.exit(1);

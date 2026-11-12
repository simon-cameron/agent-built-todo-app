import { createServer } from 'node:net';

/**
 * Picks a free loopback port first. Tests pass it as apiPort and never use port 0,
 * because Host and Origin allowlists later derive from config.apiPort.
 */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address !== null && typeof address === 'object' ? resolvePort(address.port) : reject(new Error('No port was assigned.'))));
    });
  });
}

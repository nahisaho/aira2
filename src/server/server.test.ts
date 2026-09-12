import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startServer } from './server.js';

/** @id TEST-AIRA2-RUNTIME-004
 * @verifies REQ-RUNTIME-001 REQ-RUNTIME-006
 */
describe('HTTP server entrypoint', () => {
  it('TEST-AIRA2-RUNTIME-004 starts a listening HTTP server that serves the SPA root document and /healthz', async () => {
    const dbPath = resolve('data/test-artifacts/server-start.sqlite');
    rmSync(dbPath, { force: true });
    const server = await startServer({
      port: 3017,
      dbPath,
      sharedCredentials: {},
      adapters: {},
    });

    try {
      const rootResponse = await fetch('http://127.0.0.1:3017/');
      expect(rootResponse.status).toBe(200);
      expect(await rootResponse.text()).toContain('<div id="root">');

      const healthResponse = await fetch('http://127.0.0.1:3017/healthz');
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ status: 'ok' });
    } finally {
      await server.close();
      rmSync(dbPath, { force: true });
    }
  });
});

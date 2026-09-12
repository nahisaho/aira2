import { buildApp, loadEnvConfig, type BuildAppOptions } from './app.js';

/** @id CODE-AIRA2-RUNTIME-002
 * @implements REQ-RUNTIME-001 REQ-RUNTIME-006
 * @design DES-AIRA2-011
 */
export async function startServer(options: BuildAppOptions = loadEnvConfig()): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const app = await buildApp(options);
  await app.listen({ port: options.port, host: '127.0.0.1' });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer()
    .then(() => undefined)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

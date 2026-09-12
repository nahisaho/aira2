import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const dbPath = resolve('data/test-artifacts/bootstrap-admin.sqlite');

afterEach(() => {
  rmSync(dbPath, { force: true });
});

/** @id TEST-AIRA2-AUTH-008
 * @verifies REQ-MULTIUSER-002
 */
describe('bootstrap admin account', () => {
  it('TEST-AIRA2-AUTH-008 creates exactly one bootstrap admin account when no password credentials exist yet', async () => {
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: {},
      adapters: {},
      bootstrapAdminUsername: 'bootstrap-admin',
      bootstrapAdminPassword: 'bootstrap-password',
    });
    const context = (app as unknown as { aira2: any }).aira2;

    expect(context.store.countPasswordCredentials()).toBe(1);
    expect((context.store.getAccount('bootstrap-admin') as { role?: string } | undefined)?.role).toBe('admin');

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { username: 'bootstrap-admin', password: 'bootstrap-password' },
    });
    expect(login.statusCode).toBe(200);

    await app.close();
  });
});

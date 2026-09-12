import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../auth/password-provider.js';
import { generateTotpCode } from '../auth/account-self-service.js';
import { buildApp } from './app.js';

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

const dbPath = resolve('data/test-artifacts/server-app-multiuser/server-app-multiuser.sqlite');

afterEach(() => {
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

function ensureDbDir(): void {
  mkdirSync(dirname(dbPath), { recursive: true });
}

async function loginAs(app: Awaited<ReturnType<typeof buildApp>>, username: string): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login/password',
    payload: { externalIdentity: username, username, password: 'correct-password' },
  });
  return login.json().id as string;
}

/** @id TEST-AIRA2-GATEWAY-001
 * @verifies REQ-RUNTIME-003
 */
describe('gateway routes for DES-AIRA2-013/014/015', () => {
  it('TEST-AIRA2-GATEWAY-001 wires profile, password, MFA, session, team, and invitation routes end-to-end', async () => {
    ensureDbDir();
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: {},
      adapters: {},
      bootstrapAdminUsername: 'admin-1',
      bootstrapAdminPassword: 'correct-password',
    });
    const context = (app as unknown as { aira2: any }).aira2;
    context.store.upsertPasswordCredential('owner-1', hashPassword('correct-password'));
    context.store.upsertPasswordCredential('invitee-1', hashPassword('correct-password'));

    const ownerSessionId = await loginAs(app, 'owner-1');
    const adminSessionId = await loginAs(app, 'admin-1');
    context.authz.createProject('owner-1', 'project-1');

    // Profile self-service (REQ-MULTIUSER-018/040/041)
    const profilePatch = await app.inject({
      method: 'PATCH',
      url: '/users/me/profile',
      headers: bearer(ownerSessionId),
      payload: { displayName: 'Owner One', email: 'owner-1@example.com' },
    });
    expect(profilePatch.statusCode).toBe(200);
    const [{ token: emailToken }] = context.accountSelfService.getDeliveredLinks().slice(-1);
    const confirmEmail = await app.inject({ method: 'POST', url: `/users/me/email/confirm/${emailToken}` });
    expect(confirmEmail.json()).toEqual({ status: 'ok' });

    // Password self-service (REQ-MULTIUSER-019/027)
    const passwordChange = await app.inject({
      method: 'POST',
      url: '/users/me/password',
      headers: bearer(ownerSessionId),
      payload: { currentPassword: 'correct-password', newPassword: 'new-correct-password' },
    });
    expect(passwordChange.json().status).toBe('ok');
    const newSessionId = passwordChange.json().session.id as string;
    const reloginOldPassword = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'owner-1', username: 'owner-1', password: 'correct-password' },
    });
    expect(reloginOldPassword.statusCode).toBe(401);
    const reloginNewPassword = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'owner-1', username: 'owner-1', password: 'new-correct-password' },
    });
    expect(reloginNewPassword.statusCode).toBe(200);

    // MFA enrollment and required-at-login (REQ-MULTIUSER-021/034/035)
    const enroll = await app.inject({ method: 'POST', url: '/users/me/mfa/totp/enroll', headers: bearer(newSessionId) });
    const { secret } = enroll.json() as { secret: string };
    const now = Date.now();
    const confirmCode = generateTotpCode(Buffer.from(secret, 'hex'), Math.floor(now / 30_000));
    const confirmMfa = await app.inject({
      method: 'POST',
      url: '/users/me/mfa/totp/confirm',
      headers: bearer(newSessionId),
      payload: { code: confirmCode },
    });
    expect(confirmMfa.json()).toEqual({ status: 'ok' });

    const loginWithoutCode = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'owner-1', username: 'owner-1', password: 'new-correct-password' },
    });
    expect(loginWithoutCode.statusCode).toBe(401);

    // Advance past the confirmation's time-step so the login code is a fresh, unconsumed step.
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now + 30_000);
    const loginCode = generateTotpCode(Buffer.from(secret, 'hex'), Math.floor(Date.now() / 30_000));

    const loginWithCode = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: {
        externalIdentity: 'owner-1',
        username: 'owner-1',
        password: 'new-correct-password',
        totpCode: loginCode,
      },
    });
    dateNowSpy.mockRestore();
    expect(loginWithCode.statusCode).toBe(200);
    const mfaSessionId = loginWithCode.json().id as string;

    // Session self-service listing/revocation (REQ-MULTIUSER-023/024)
    const listSessions = await app.inject({ method: 'GET', url: '/users/me/sessions', headers: bearer(mfaSessionId) });
    expect(listSessions.json().length).toBeGreaterThan(0);

    // Invitation and team routes (REQ-MULTIUSER-013/014/015/016)
    const invitation = await app.inject({
      method: 'POST',
      url: '/projects/project-1/invitations',
      headers: bearer(mfaSessionId),
      payload: { email: 'invitee-1@example.com', role: 'editor' },
    });
    expect(invitation.statusCode).toBe(200);

    const inviteeSessionId = await loginAs(app, 'invitee-1');
    await app.inject({
      method: 'PATCH',
      url: '/users/me/profile',
      headers: bearer(inviteeSessionId),
      payload: { email: 'invitee-1@example.com' },
    });
    const [{ token: inviteeEmailToken }] = context.accountSelfService.getDeliveredLinks().slice(-1);
    await app.inject({ method: 'POST', url: `/users/me/email/confirm/${inviteeEmailToken}` });

    const acceptInvitation = await app.inject({
      method: 'POST',
      url: `/invitations/${invitation.json().token}/accept`,
      headers: bearer(inviteeSessionId),
    });
    expect(acceptInvitation.json()).toEqual({ status: 'ok', projectId: 'project-1', role: 'editor' });

    const members = await app.inject({ method: 'GET', url: '/projects/project-1/members', headers: bearer(mfaSessionId) });
    expect(members.json().members).toEqual(expect.arrayContaining([{ userId: 'invitee-1', role: 'editor' }]));

    const team = await app.inject({ method: 'POST', url: '/teams', headers: bearer(adminSessionId), payload: { name: 'Team A' } });
    expect(team.statusCode).toBe(200);
    const teamShare = await app.inject({
      method: 'POST',
      url: '/projects/project-1/team-shares',
      headers: bearer(mfaSessionId),
      payload: { teamId: team.json().id, role: 'viewer' },
    });
    expect(teamShare.statusCode).toBe(200);

    await app.close();
  });
});

/** @id TEST-AIRA2-GATEWAY-002
 * @verifies REQ-RUNTIME-007
 */
describe('gateway authorization enforcement for new routes', () => {
  it('TEST-AIRA2-GATEWAY-002 rejects an unauthenticated caller for the new self-service and team routes', async () => {
    ensureDbDir();
    const app = await buildApp({ port: 3000, dbPath, sharedCredentials: {}, adapters: {} });

    const sessions = await app.inject({ method: 'GET', url: '/users/me/sessions' });
    expect(sessions.statusCode).toBe(401);

    const profile = await app.inject({ method: 'GET', url: '/users/me/profile' });
    expect(profile.statusCode).toBe(401);

    const teams = await app.inject({ method: 'POST', url: '/teams', payload: { name: 'Team B' } });
    expect(teams.statusCode).toBe(401);

    await app.close();
  });
});

/** @id TEST-AIRA2-GATEWAY-003
 * @verifies REQ-MULTIUSER-027
 */
describe('password reset persistence', () => {
  it('TEST-AIRA2-GATEWAY-003 persists a completed password reset to the durable store, surviving process restart', async () => {
    ensureDbDir();
    const app1 = await buildApp({ port: 3000, dbPath, sharedCredentials: {}, adapters: {} });
    const context1 = (app1 as unknown as { aira2: any }).aira2;
    context1.store.upsertPasswordCredential('reset-user-1', hashPassword('old-password'));
    context1.accountSelfService.registerAccount('reset-user-1', 'Reset User', 'reset-user-1@example.com', hashPassword('old-password'));

    const resetRequest = await app1.inject({
      method: 'POST',
      url: '/password-reset/request',
      payload: { email: 'reset-user-1@example.com' },
    });
    expect(resetRequest.statusCode).toBe(200);
    const [{ token }] = context1.accountSelfService.getDeliveredLinks().slice(-1);

    const resetComplete = await app1.inject({
      method: 'POST',
      url: `/password-reset/${token}/complete`,
      payload: { newPassword: 'brand-new-password' },
    });
    expect(resetComplete.json()).toEqual({ status: 'ok', accountId: 'reset-user-1' });
    await app1.close();

    // Simulate a process restart: a fresh app instance backed by the same store must see the new
    // password, proving the reset was synced to durable storage rather than only kept in-memory.
    const app2 = await buildApp({ port: 3000, dbPath, sharedCredentials: {}, adapters: {} });
    const oldPasswordLogin = await app2.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'reset-user-1', username: 'reset-user-1', password: 'old-password' },
    });
    expect(oldPasswordLogin.statusCode).toBe(401);

    const newPasswordLogin = await app2.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'reset-user-1', username: 'reset-user-1', password: 'brand-new-password' },
    });
    expect(newPasswordLogin.statusCode).toBe(200);
    await app2.close();
  });
});

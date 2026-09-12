import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmBackendAdapter, ProviderId } from '../llm/adapters.js';
import { hashPassword } from '../auth/password-provider.js';
import { buildApp, loadEnvConfig, loadVaultKey } from './app.js';

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

function adapter(providerId: ProviderId, content: string): LlmBackendAdapter {
  return {
    providerId,
    chat: vi.fn(async () => ({ providerId, content })),
  };
}

const dbPath = resolve('data/test-artifacts/server-app.sqlite');
const frontendDistPath = resolve('data/test-artifacts/frontend-dist');

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(frontendDistPath, { recursive: true, force: true });
  rmSync(join(dirname(dbPath), 'aira-graphdb'), { recursive: true, force: true });
});

/** @id TEST-AIRA2-RUNTIME-002
 * @verifies REQ-RUNTIME-001 REQ-RUNTIME-005 REQ-RUNTIME-006 REQ-RUNTIME-009 REQ-RUNTIME-010
 */
describe('server bootstrap and health route', () => {
  it('TEST-AIRA2-RUNTIME-002 exposes healthz and bootstraps env shared credentials once without overwriting stored values', async () => {
    mkdirSync(dirname(dbPath), { recursive: true });
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: { openai: 'env-secret-1' },
      adapters: { openai: adapter('openai', 'hello') },
    });

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const context = (app as unknown as { aira2: any }).aira2;
    context.authz.createProject('owner-1', 'project-1');
    const ownerActor = context.actorForAccount('owner-1');
    expect(context.vault.getCredentialForRequest(ownerActor, 'project-1', 'openai')).toBe('env-secret-1');

    context.vault.setAdminSharedCredential(context.systemActor, 'openai', 'api-secret-2');
    await app.close();

    const restarted = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: { openai: 'env-secret-3' },
      adapters: { openai: adapter('openai', 'hello') },
    });
    const restartedContext = (restarted as unknown as { aira2: any }).aira2;
    expect(restartedContext.vault.getCredentialForRequest(restartedContext.actorForAccount('owner-1'), 'project-1', 'openai')).toBe('api-secret-2');
    await restarted.close();

    const defaults = loadEnvConfig({});
    expect(defaults.port).toBe(3000);
    expect(defaults.dbPath).toBe('./data/aira2.sqlite');
    expect(defaults.sharedCredentials).toEqual({});
  });
});

/** @id TEST-AIRA2-RUNTIME-007
 * @verifies REQ-RUNTIME-005
 */
describe('vault key loading', () => {
  it('TEST-AIRA2-RUNTIME-007 accepts a valid env-configured vault key and rejects missing or malformed production keys', () => {
    const hexKey = '11'.repeat(32);
    expect(loadVaultKey({ AIRA2_VAULT_KEY: hexKey, NODE_ENV: 'production' })).toEqual(Buffer.from(hexKey, 'hex'));
    expect(() => loadVaultKey({ NODE_ENV: 'production' })).toThrowError(/AIRA2_VAULT_KEY/);
    expect(() => loadVaultKey({ AIRA2_VAULT_KEY: 'short', NODE_ENV: 'production' })).toThrowError(
      /64-character hex string/,
    );
  });
});

/** @id TEST-AIRA2-AUTH-005
 * @verifies REQ-MULTIUSER-001
 */
describe('password login route', () => {
  it('TEST-AIRA2-AUTH-005 rejects a wrong password, accepts a correct password, and returns a working session', async () => {
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: {},
      adapters: {},
    });
    const context = (app as unknown as { aira2: any }).aira2;
    context.store.upsertPasswordCredential('member-1', hashPassword('correct-password'));

    const rejected = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'member-1', username: 'member-1', password: 'wrong-password' },
    });
    expect(rejected.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'member-1', username: 'member-1', password: 'correct-password' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().id).toMatch(/^[0-9a-f]{64}$/);

    const currentSession = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: bearer(accepted.json().id as string),
    });
    expect(currentSession.statusCode).toBe(200);
    expect(currentSession.json().accountId).toBe('member-1');

    await app.close();
  });
});

/** @id TEST-AIRA2-AUTH-006
 * @verifies REQ-MULTIUSER-002
 */
describe('account role assignment at login', () => {
  it('TEST-AIRA2-AUTH-006 ignores a login body role override for a non-bootstrap account and reserves admin for the bootstrap account', async () => {
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: {},
      adapters: {},
    });
    const context = (app as unknown as { aira2: any }).aira2;
    context.store.upsertPasswordCredential('member-2', hashPassword('correct-password'));

    const memberLogin = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: {
        externalIdentity: 'member-2',
        username: 'member-2',
        password: 'correct-password',
        role: 'admin',
      },
    });
    expect(memberLogin.statusCode).toBe(200);
    expect((context.store.getAccount('member-2') as { role?: string } | undefined)?.role).toBe('member');

    await app.close();
  });
});

/** @id TEST-AIRA2-AUTH-007
 * @verifies REQ-MULTIUSER-007
 */
describe('selectable but unimplemented authentication methods', () => {
  it('TEST-AIRA2-AUTH-007 keeps password, github-oauth, and oidc listed while rejecting github-oauth and oidc login attempts with 501', async () => {
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: {},
      adapters: {},
    });

    const methods = await app.inject({ method: 'GET', url: '/auth/methods' });
    expect(methods.statusCode).toBe(200);
    expect(methods.json()).toEqual(['github-oauth', 'password', 'oidc']);

    const github = await app.inject({
      method: 'POST',
      url: '/auth/login/github-oauth',
      payload: { token: 'oauth-token' },
    });
    expect(github.statusCode).toBe(501);

    const oidc = await app.inject({
      method: 'POST',
      url: '/auth/login/oidc',
      payload: { token: 'oidc-token' },
    });
    expect(oidc.statusCode).toBe(501);

    await app.close();
  });
});

/** @id TEST-AIRA2-RUNTIME-003
 * @verifies REQ-RUNTIME-003 REQ-RUNTIME-007 REQ-RUNTIME-011
 */
describe('REST API gateway and chat execution', () => {
  it('TEST-AIRA2-RUNTIME-003 serves authenticated operation groups, rejects unauthenticated callers, and returns authorization denials as 403', async () => {
    const openAi = adapter('openai', 'openai says hi');
    const anthropic = adapter('anthropic', 'anthropic says hi');
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: { openai: 'shared-openai' },
      adapters: { openai: openAi, anthropic },
    });
    const context = (app as unknown as { aira2: any }).aira2;
    context.store.upsertPasswordCredential('owner-1', hashPassword('owner-password'));
    context.store.upsertPasswordCredential('viewer-1', hashPassword('viewer-password'));

    const ownerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { username: 'owner-1', password: 'owner-password' },
    });
    const ownerSessionId = ownerLogin.json().id as string;
    context.authz.createProject('owner-1', 'project-1');

    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { username: 'viewer-1', password: 'viewer-password' },
    });
    const viewerSessionId = viewerLogin.json().id as string;

    const unauthenticated = await app.inject({ method: 'GET', url: '/projects/project-1/agent-skills' });
    expect(unauthenticated.statusCode).toBe(401);

    const share = await app.inject({
      method: 'POST',
      url: '/projects/project-1/shares',
      headers: bearer(ownerSessionId),
      payload: { userId: 'viewer-1', role: 'viewer' },
    });
    expect(share.statusCode).toBe(200);

    const llmSettings = await app.inject({
      method: 'POST',
      url: '/llm/default-backend',
      headers: bearer(viewerSessionId),
      payload: { providerId: 'openai', model: 'gpt-4o' },
    });
    expect(llmSettings.statusCode).toBe(200);

    const credential = await app.inject({
      method: 'POST',
      url: '/credentials/self/openai',
      headers: bearer(viewerSessionId),
      payload: { secret: 'viewer-openai' },
    });
    expect(credential.statusCode).toBe(200);

    const agentSkills = await app.inject({
      method: 'POST',
      url: '/projects/project-1/agent-skills',
      headers: bearer(ownerSessionId),
      payload: [{ skillId: 'chat', enabled: true }],
    });
    expect(agentSkills.statusCode).toBe(200);

    const protocol = await app.inject({
      method: 'POST',
      url: '/projects/project-1/eln/protocols',
      headers: bearer(ownerSessionId),
      payload: { content: 'SOP content' },
    });
    expect(protocol.statusCode).toBe(200);

    const graphIndex = await app.inject({
      method: 'POST',
      url: '/projects/project-1/graphrag/index',
      headers: bearer(ownerSessionId),
      payload: [{ documentId: 'doc-1', content: 'Kinase evidence' }],
    });
    expect(graphIndex.statusCode).toBe(200);

    const chat = await app.inject({
      method: 'POST',
      url: '/projects/project-1/chat',
      headers: bearer(viewerSessionId),
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().content).toBe('openai says hi');

    const forbidden = await app.inject({
      method: 'POST',
      url: '/projects/project-1/llm/backend-override',
      headers: bearer(viewerSessionId),
      payload: { providerId: 'openai', model: 'gpt-4o' },
    });
    expect(forbidden.statusCode).toBe(403);

    await app.close();
  });
});

/** @id TEST-AIRA2-RUNTIME-008
 * @verifies REQ-RUNTIME-007
 */
describe('protocol route authorization and export authorization', () => {
  it('TEST-AIRA2-RUNTIME-008 rejects a viewer from creating/versioning protocols or exporting ELN records', async () => {
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: {},
      adapters: {},
    });
    const context = (app as unknown as { aira2: any }).aira2;
    context.store.upsertPasswordCredential('owner-1', hashPassword('owner-password'));
    context.store.upsertPasswordCredential('viewer-1', hashPassword('viewer-password'));

    const ownerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { username: 'owner-1', password: 'owner-password' },
    });
    context.authz.createProject('owner-1', 'project-1');

    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { username: 'viewer-1', password: 'viewer-password' },
    });
    await app.inject({
      method: 'POST',
      url: '/projects/project-1/shares',
      headers: bearer(ownerLogin.json().id as string),
      payload: { userId: 'viewer-1', role: 'viewer' },
    });

    const protocol = await app.inject({
      method: 'POST',
      url: '/projects/project-1/eln/protocols',
      headers: bearer(ownerLogin.json().id as string),
      payload: { content: 'Protocol v1' },
    });
    const protocolId = protocol.json().protocolId as string;
    const record = await app.inject({
      method: 'POST',
      url: '/projects/project-1/eln/records',
      headers: bearer(ownerLogin.json().id as string),
      payload: {
        objective: 'objective',
        method: 'method',
        rawData: 'raw',
        results: 'results',
        conclusion: 'conclusion',
      },
    });
    const recordId = record.json().recordId as string;

    const createDenied = await app.inject({
      method: 'POST',
      url: '/projects/project-1/eln/protocols',
      headers: bearer(viewerLogin.json().id as string),
      payload: { content: 'Viewer protocol' },
    });
    expect(createDenied.statusCode).toBe(403);

    const versionDenied = await app.inject({
      method: 'POST',
      url: `/projects/project-1/eln/protocols/${protocolId}/versions`,
      headers: bearer(viewerLogin.json().id as string),
      payload: { content: 'Viewer version' },
    });
    expect(versionDenied.statusCode).toBe(403);

    const exportDenied = await app.inject({
      method: 'POST',
      url: `/projects/project-1/eln/records/${recordId}/export`,
      headers: bearer(viewerLogin.json().id as string),
    });
    expect(exportDenied.statusCode).toBe(403);

    await app.close();
  });
});

/** @id TEST-AIRA2-RUNTIME-005
 * @verifies REQ-RUNTIME-004 REQ-RUNTIME-008
 */
describe('SPA root document', () => {
  it('TEST-AIRA2-RUNTIME-005 serves built SPA assets with an index fallback and does not expose the prior minimal-contract UI layer as a route', async () => {
    mkdirSync(join(frontendDistPath, 'assets'), { recursive: true });
    writeFileSync(join(frontendDistPath, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>');
    writeFileSync(join(frontendDistPath, 'assets', 'main.js'), 'console.log("built");');
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: {},
      adapters: {},
      serveBuiltFrontend: true,
      frontendDistDir: frontendDistPath,
    });

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<div id="root"></div>');
    expect(root.body).toContain('/assets/main.js');

    const asset = await app.inject({ method: 'GET', url: '/assets/main.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log("built")');

    const fallback = await app.inject({ method: 'GET', url: '/projects/project-1/client-route' });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toContain('/assets/main.js');

    const legacy = await app.inject({ method: 'GET', url: '/web/auth-ui' });
    expect(legacy.statusCode).toBe(404);

    await app.close();
  });
});

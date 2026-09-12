import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmBackendAdapter, ProviderId } from '../llm/adapters.js';
import { buildApp, loadEnvConfig } from './app.js';

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

afterEach(() => {
  rmSync(dbPath, { force: true });
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

    const ownerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'owner-1', displayName: 'Owner 1' },
    });
    const ownerSessionId = ownerLogin.json().id as string;
    context.authz.createProject('owner-1', 'project-1');

    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login/password',
      payload: { externalIdentity: 'viewer-1', displayName: 'Viewer 1' },
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

/** @id TEST-AIRA2-RUNTIME-005
 * @verifies REQ-RUNTIME-004 REQ-RUNTIME-008
 */
describe('SPA root document', () => {
  it('TEST-AIRA2-RUNTIME-005 serves a real SPA root document and does not expose the prior minimal-contract UI layer as a route', async () => {
    const app = await buildApp({
      port: 3000,
      dbPath,
      sharedCredentials: {},
      adapters: {},
    });

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<div id="root"></div>');
    expect(root.body).toContain('/src/main.tsx');

    const legacy = await app.inject({ method: 'GET', url: '/web/auth-ui' });
    expect(legacy.statusCode).toBe(404);

    await app.close();
  });
});

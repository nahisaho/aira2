import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../authz/audit.js';
import { ProjectAuthorizationService, type RevocationNotifier } from '../authz/project-authz.js';
import { CredentialVault } from '../vault/credential-vault.js';
import { LlmBackendGateway, type BackendSelection } from '../llm/gateway.js';
import type { LlmBackendAdapter, ProviderId } from '../llm/adapters.js';
import { AgentSkillsMcpConfigManager } from '../agent-config/agent-skills-mcp-manager.js';
import { SqliteStore } from './store.js';

const TEST_KEY = Buffer.alloc(32, 9);

function fakeAdapter(providerId: ProviderId, content: string): LlmBackendAdapter {
  return {
    providerId,
    chat: vi.fn(async () => ({ providerId, content })),
  };
}

function actor(accountId: string, isGlobalAdmin = false) {
  return {
    accountId,
    isGlobalAdmin,
    authorizeProject: (projectId: string, action: string) => authz.authorize({ accountId, isGlobalAdmin }, projectId, action),
  };
}

let authz: ProjectAuthorizationService;

function setupServices(dbPath: string) {
  const store = new SqliteStore({ dbPath });
  const audit = new AuditLog(store);
  const notifier: RevocationNotifier = { terminateSessionsAndConnections: vi.fn() };
  authz = new ProjectAuthorizationService(audit, notifier, store);
  const vault = new CredentialVault(TEST_KEY, store);
  const gateway = new LlmBackendGateway(
    {
      anthropic: fakeAdapter('anthropic', 'anthropic reply'),
      openai: fakeAdapter('openai', 'openai reply'),
    },
    vault,
    store,
  );
  const agentConfig = new AgentSkillsMcpConfigManager(authz, store);
  return { store, authz, vault, gateway, agentConfig };
}

function selection(providerId: ProviderId, model: string): BackendSelection {
  return { providerId, model };
}

const dbPath = resolve('data/test-artifacts/runtime-store.sqlite');

afterEach(() => {
  rmSync(dbPath, { force: true });
});

/** @id TEST-AIRA2-RUNTIME-001
 * @verifies REQ-RUNTIME-002 REQ-LLMBACKEND-002 REQ-LLMBACKEND-004 REQ-LLMBACKEND-008
 */
describe('sqlite-backed runtime persistence', () => {
  it('TEST-AIRA2-RUNTIME-001 preserves project shares, credentials, backend selections, and agent config across a store reopen', async () => {
    mkdirSync(dirname(dbPath), { recursive: true });

    {
      const { store, authz: authz1, vault, gateway, agentConfig } = setupServices(dbPath);
      authz1.createProject('owner-1', 'project-1');
      authz1.grantShare({ accountId: 'owner-1' }, 'project-1', 'viewer-1', 'viewer');

      vault.setAdminSharedCredential({ accountId: 'admin-1', isGlobalAdmin: true, authorizeProject: () => false }, 'openai', 'sk-shared');
      vault.setUserOverrideCredential({ accountId: 'viewer-1', isGlobalAdmin: false, authorizeProject: () => true }, 'openai', 'sk-personal');

      gateway.setUserDefaultBackend(actor('viewer-1'), selection('anthropic', 'claude-3-5-sonnet'));
      gateway.setProjectBackendOverride(actor('owner-1'), 'project-1', selection('openai', 'gpt-4.1'));

      agentConfig.setAgentSkills({ accountId: 'owner-1' }, 'project-1', [{ skillId: 'eln-review', enabled: true }]);
      agentConfig.setMcpServers({ accountId: 'owner-1' }, 'project-1', [
        { serverId: 'graphrag', command: 'builtin', args: ['graphrag'], enabled: true },
      ]);
      store.close();
    }

    {
      const { store, authz: authz2, vault, gateway, agentConfig } = setupServices(dbPath);
      expect(authz2.authorize({ accountId: 'viewer-1' }, 'project-1', 'eln.view')).toBe(true);
      expect(authz2.authorize({ accountId: 'viewer-1' }, 'project-1', 'eln.edit')).toBe(false);

      expect(
        vault.getCredentialForRequest(
          { accountId: 'viewer-1', isGlobalAdmin: false, authorizeProject: (projectId, action) => authz2.authorize({ accountId: 'viewer-1' }, projectId, action) },
          'project-1',
          'openai',
        ),
      ).toBe('sk-personal');

      expect(gateway.resolveBackend(actor('viewer-1'), 'project-1')).toEqual(selection('openai', 'gpt-4.1'));
      expect(agentConfig.getAgentSkills({ accountId: 'viewer-1' }, 'project-1')).toEqual([
        { skillId: 'eln-review', enabled: true },
      ]);
      expect(agentConfig.getMcpServers({ accountId: 'viewer-1' }, 'project-1')).toEqual([
        { serverId: 'graphrag', command: 'builtin', args: ['graphrag'], enabled: true },
      ]);
      store.close();
    }
  });
});

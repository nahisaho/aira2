import { describe, expect, it } from 'vitest';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';
import { AuditLedger } from '../eln-audit/ledger.js';
import { ProtocolStore } from '../eln/protocol-store.js';
import { ElnCoreService } from '../eln/eln-core-service.js';
import { GraphDbSupervisor } from '../graphrag/graphdb.js';
import { GraphRagService, type GraphRagLlmGateway } from '../graphrag/graphrag-service.js';
import { LlmBackendGateway } from '../llm/gateway.js';
import { CredentialVault } from '../vault/credential-vault.js';
import { createAccount, type Account } from '../auth/account.js';
import type { AuthProvider, DeploymentAuthConfig } from '../auth/login.js';
import { AuthUiController } from './auth-ui.js';
import { LlmSettingsUiController } from './llm-settings-ui.js';
import { ElnUiController } from './eln-ui.js';
import { GraphRagUiController } from './graphrag-ui.js';
import { ProjectsUiController } from './projects-ui.js';
import { DESIGN_TOKENS, DesignSystemRegistry, UnstyledUiAreaError } from './design-system.js';

function buildFullyRegisteredRegistry(): DesignSystemRegistry {
  const registry = new DesignSystemRegistry();

  const authz = new ProjectAuthorizationService(new AuditLog(), {
    terminateSessionsAndConnections: () => undefined,
  });
  authz.createProject('owner-1', 'project-1');

  const config: DeploymentAuthConfig = { enabledMethods: ['password'] };
  const accounts = new Map<string, Account>();
  accounts.set('owner-1', createAccount({ displayName: 'Owner One', externalIdentity: 'owner-1' }));
  const provider: AuthProvider = { method: 'password', resolveExternalIdentity: () => 'owner-1' };
  new AuthUiController(config, [provider], accounts, registry); // registers 'chat'

  new ProjectsUiController(authz, registry); // registers 'projects'

  const gateway = new LlmBackendGateway({});
  const vault = new CredentialVault(Buffer.alloc(32, 1));
  new LlmSettingsUiController(gateway, vault, registry); // registers 'settings'

  const ledger = new AuditLedger();
  const protocolStore = new ProtocolStore();
  const elnCoreService = new ElnCoreService(authz, ledger, protocolStore);
  new ElnUiController(authz, elnCoreService, ledger, registry); // registers 'eln'

  const supervisor = new GraphDbSupervisor();
  const graphRagGateway: GraphRagLlmGateway = {
    resolveBackend: () => 'openai',
    chat: async () => ({ providerId: 'openai', content: '' }),
  };
  const graphRagService = new GraphRagService(authz, supervisor, graphRagGateway);
  new GraphRagUiController(graphRagService, registry); // registers 'graphrag'

  return registry;
}

/** @id TEST-AIRA2-GUI-005
 * @verifies REQ-GUI-005
 */
describe('shared visual design system', () => {
  it('TEST-AIRA2-GUI-005 confirms every UI area shares the same design tokens/component library with no unstyled screens remaining', () => {
    const registry = buildFullyRegisteredRegistry();

    expect(registry.isFullyStyled()).toBe(true);
    expect(registry.unstyledAreas()).toEqual([]);

    for (const area of ['chat', 'projects', 'settings', 'eln', 'graphrag'] as const) {
      expect(registry.styleFor(area)?.designTokens).toBe(DESIGN_TOKENS);
      expect(registry.styleFor(area)?.designTokens.componentLibrary).toBe('aira2-ui-kit');
    }
  });

  it('TEST-AIRA2-GUI-005 rejects an area that does not use the shared design tokens', () => {
    const registry = new DesignSystemRegistry();
    expect(() =>
      registry.register('chat', { name: 'legacy', colorScheme: 'legacy', componentLibrary: 'legacy-kit' }),
    ).toThrow(UnstyledUiAreaError);
  });
});

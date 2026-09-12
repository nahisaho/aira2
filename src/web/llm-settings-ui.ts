import { LlmBackendGateway, type BackendSelection, type GatewayActorContext } from '../llm/gateway.js';
import type { ProviderId } from '../llm/adapters.js';
import { CredentialVault, type MaskedCredentialEntry, type VaultActorContext } from '../vault/credential-vault.js';
import { DesignSystemRegistry } from './design-system.js';

export interface LlmSettingsView {
  selectedBackend: BackendSelection;
  selectedProvider: ProviderId;
  /** Only masked entries are ever surfaced to the client-rendered state. */
  credentials: MaskedCredentialEntry[];
}

/** @id CODE-AIRA2-GUI-003
 * @implements REQ-GUI-002
 * @design DES-AIRA2-010
 * View-model for the LLM backend settings UI: lets a user view/select
 * their default provider and view (never raw-value) their configured
 * credentials, and immediately affects the provider resolved for the
 * user's subsequent requests.
 */
export class LlmSettingsUiController {
  constructor(
    private readonly gateway: LlmBackendGateway,
    private readonly vault: CredentialVault,
    registry: DesignSystemRegistry = new DesignSystemRegistry(),
  ) {
    registry.register('settings');
  }

  selectProvider(actor: GatewayActorContext, providerId: ProviderId, model = 'default'): void {
    this.gateway.setUserDefaultBackend(actor, { providerId, model });
  }

  setCredential(actor: VaultActorContext, provider: string, secret: string): void {
    this.vault.setUserOverrideCredential(actor, provider, secret);
  }

  view(actor: GatewayActorContext & VaultActorContext, projectId: string): LlmSettingsView {
    return {
      selectedBackend: this.gateway.resolveBackend(actor, projectId),
      selectedProvider: this.gateway.resolveBackend(actor, projectId).providerId,
      credentials: this.vault.listSelfCredentials(actor),
    };
  }
}

import { authorizeSelf, type SelfScopeActorContext } from '../authz/self-scope.js';
import type { ChatRequest, ChatResponse, LlmBackendAdapter, ProviderId } from './adapters.js';
import { CredentialVault } from '../vault/credential-vault.js';
import { SqliteStore } from '../server/store.js';

export interface GatewayActorContext extends SelfScopeActorContext {
  authorizeProject(projectId: string, action: string): boolean;
}

export class LlmAuthorizationDeniedError extends Error {
  constructor(action: string) {
    super(`LLM backend authorization denied for action: ${action}`);
  }
}

/** @id CODE-AIRA2-LLM-006
 * @implements REQ-LLMBACKEND-006
 * @design DES-AIRA2-004
 */
export class BackendFailureError extends Error {
  constructor(
    public readonly providerId: ProviderId,
    cause: unknown,
  ) {
    super(
      `LLM backend '${providerId}' request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export const DEFAULT_PROVIDER_ID: ProviderId = 'github-copilot-cli';
const DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<ProviderId, string>> = {
  'github-copilot-cli': 'copilot-default',
  openai: 'gpt-4o',
  'azure-openai': 'gpt-4o',
  anthropic: 'claude-3-5-sonnet',
};

export interface BackendSelection {
  providerId: ProviderId;
  model: string;
}

export const DEFAULT_BACKEND_SELECTION: BackendSelection = {
  providerId: DEFAULT_PROVIDER_ID,
  model: DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID],
};

function normalizeSelection(selection: ProviderId | BackendSelection): BackendSelection {
  if (typeof selection === 'string') {
    return { providerId: selection, model: DEFAULT_MODEL_BY_PROVIDER[selection] };
  }
  return selection;
}

/** @id CODE-AIRA2-LLM-005
 * @implements REQ-LLMBACKEND-002 REQ-LLMBACKEND-008 REQ-RUNTIME-011
 * @design DES-AIRA2-004
 */
export class LlmBackendGateway {
  constructor(
    private readonly adapters: Partial<Record<ProviderId, LlmBackendAdapter>>,
    private readonly vault?: CredentialVault,
    private readonly store: SqliteStore = new SqliteStore({ dbPath: ':memory:' }),
  ) {}

  setUserDefaultBackend(actor: GatewayActorContext, selection: ProviderId | BackendSelection): void {
    if (!authorizeSelf(actor, 'llmbackend.user-default.modify')) {
      throw new LlmAuthorizationDeniedError('llmbackend.user-default.modify');
    }
    const normalized = normalizeSelection(selection);
    this.store.setUserBackendDefault(actor.accountId, normalized.providerId, normalized.model);
  }

  setProjectBackendOverride(
    actor: GatewayActorContext,
    projectId: string,
    selection: ProviderId | BackendSelection,
  ): void {
    if (!actor.authorizeProject(projectId, 'llmbackend.project-override.modify')) {
      throw new LlmAuthorizationDeniedError('llmbackend.project-override.modify');
    }
    const normalized = normalizeSelection(selection);
    this.store.setProjectBackendOverride(projectId, normalized.providerId, normalized.model);
  }

  resolveBackend(actor: GatewayActorContext, projectId: string): BackendSelection {
    if (!actor.authorizeProject(projectId, 'llmbackend.project-override.view')) {
      throw new LlmAuthorizationDeniedError('llmbackend.project-override.view');
    }
    return (
      (this.store.getProjectBackendOverride(projectId) as BackendSelection | null) ??
      (this.store.getUserBackendDefault(actor.accountId) as BackendSelection | null) ??
      DEFAULT_BACKEND_SELECTION
    );
  }

  /** @id CODE-AIRA2-LLM-007
   * @implements REQ-LLMBACKEND-004 REQ-LLMBACKEND-006 REQ-RUNTIME-011
   * @design DES-AIRA2-004
   * On failure, rethrows a BackendFailureError tagged with the failing
   * provider — it must never silently retry against a different adapter.
   */
  async chat(
    actor: GatewayActorContext,
    projectId: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const selection = this.resolveBackend(actor, projectId);
    const adapter = this.adapters[selection.providerId];
    if (!adapter) {
      throw new BackendFailureError(selection.providerId, new Error('adapter not configured'));
    }
    try {
      const credential = this.vault?.getCredentialForRequest(actor, projectId, selection.providerId);
      return await adapter.chat(
        { ...request, model: selection.model },
        credential ? { credential, model: selection.model } : undefined,
      );
    } catch (cause) {
      throw new BackendFailureError(selection.providerId, cause);
    }
  }
}

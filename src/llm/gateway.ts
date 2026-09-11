import { authorizeSelf, type SelfScopeActorContext } from '../authz/self-scope.js';
import type { ChatRequest, ChatResponse, LlmBackendAdapter, ProviderId } from './adapters.js';

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

/** @id CODE-AIRA2-LLM-005
 * @implements REQ-LLMBACKEND-002 REQ-LLMBACKEND-008
 * @design DES-AIRA2-004
 */
export class LlmBackendGateway {
  private readonly userDefaults = new Map<string, ProviderId>();
  private readonly projectOverrides = new Map<string, ProviderId>();

  constructor(private readonly adapters: Partial<Record<ProviderId, LlmBackendAdapter>>) {}

  setUserDefaultBackend(actor: GatewayActorContext, providerId: ProviderId): void {
    if (!authorizeSelf(actor, 'llmbackend.user-default.modify')) {
      throw new LlmAuthorizationDeniedError('llmbackend.user-default.modify');
    }
    this.userDefaults.set(actor.accountId, providerId);
  }

  setProjectBackendOverride(
    actor: GatewayActorContext,
    projectId: string,
    providerId: ProviderId,
  ): void {
    if (!actor.authorizeProject(projectId, 'llmbackend.project-override.modify')) {
      throw new LlmAuthorizationDeniedError('llmbackend.project-override.modify');
    }
    this.projectOverrides.set(projectId, providerId);
  }

  resolveBackend(actor: GatewayActorContext, projectId: string): ProviderId {
    if (!actor.authorizeProject(projectId, 'llmbackend.project-override.view')) {
      throw new LlmAuthorizationDeniedError('llmbackend.project-override.view');
    }
    return (
      this.projectOverrides.get(projectId) ?? this.userDefaults.get(actor.accountId) ?? DEFAULT_PROVIDER_ID
    );
  }

  /** @id CODE-AIRA2-LLM-007
   * @implements REQ-LLMBACKEND-006
   * @design DES-AIRA2-004
   * On failure, rethrows a BackendFailureError tagged with the failing
   * provider — it must never silently retry against a different adapter.
   */
  async chat(
    actor: GatewayActorContext,
    projectId: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const providerId = this.resolveBackend(actor, projectId);
    const adapter = this.adapters[providerId];
    if (!adapter) {
      throw new BackendFailureError(providerId, new Error('adapter not configured'));
    }
    try {
      return await adapter.chat(request);
    } catch (cause) {
      throw new BackendFailureError(providerId, cause);
    }
  }
}

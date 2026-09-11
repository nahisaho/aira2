import { describe, expect, it, vi } from 'vitest';
import type { ChatRequest, LlmBackendAdapter, ProviderId } from './adapters.js';
import {
  BackendFailureError,
  LlmAuthorizationDeniedError,
  LlmBackendGateway,
  type GatewayActorContext,
} from './gateway.js';

function fakeAdapter(providerId: ProviderId, content: string): LlmBackendAdapter {
  return {
    providerId,
    chat: vi.fn(async () => ({ providerId, content })),
  };
}

function actor(
  accountId: string,
  opts: Partial<Pick<GatewayActorContext, 'isGlobalAdmin' | 'authorizeProject'>> = {},
): GatewayActorContext {
  return {
    accountId,
    isGlobalAdmin: opts.isGlobalAdmin ?? false,
    authorizeProject: opts.authorizeProject ?? (() => true),
  };
}

const REQUEST: ChatRequest = { messages: [{ role: 'user', content: 'hello' }] };

/** @id TEST-AIRA2-LLM-002
 * @verifies REQ-LLMBACKEND-002
 */
describe('per-user default backend selection', () => {
  it('TEST-AIRA2-LLM-002 routes each user\'s request to their own configured default backend', async () => {
    const anthropicAdapter = fakeAdapter('anthropic', 'from anthropic');
    const azureAdapter = fakeAdapter('azure-openai', 'from azure');
    const gateway = new LlmBackendGateway({ anthropic: anthropicAdapter, 'azure-openai': azureAdapter });

    gateway.setUserDefaultBackend(actor('user-a'), 'anthropic');
    gateway.setUserDefaultBackend(actor('user-b'), 'azure-openai');

    const resultA = await gateway.chat(actor('user-a'), 'project-1', REQUEST);
    const resultB = await gateway.chat(actor('user-b'), 'project-1', REQUEST);

    expect(resultA.providerId).toBe('anthropic');
    expect(resultB.providerId).toBe('azure-openai');
  });
});

/** @id TEST-AIRA2-LLM-003
 * @verifies REQ-LLMBACKEND-006
 */
describe('backend failure fallback notice', () => {
  it('TEST-AIRA2-LLM-003 surfaces a provider-identified failure without silently invoking another provider', async () => {
    const failingAdapter: LlmBackendAdapter = {
      providerId: 'openai',
      chat: vi.fn(async () => {
        throw new Error('invalid api key');
      }),
    };
    const otherAdapter = fakeAdapter('anthropic', 'should not be called');
    const gateway = new LlmBackendGateway({ openai: failingAdapter, anthropic: otherAdapter });
    gateway.setUserDefaultBackend(actor('user-a'), 'openai');

    await expect(gateway.chat(actor('user-a'), 'project-1', REQUEST)).rejects.toThrow(
      BackendFailureError,
    );
    await expect(gateway.chat(actor('user-a'), 'project-1', REQUEST)).rejects.toMatchObject({
      providerId: 'openai',
    });
    expect(otherAdapter.chat).not.toHaveBeenCalled();
  });
});

/** @id TEST-AIRA2-LLM-004
 * @verifies REQ-LLMBACKEND-008
 */
describe('project backend override precedence', () => {
  it('TEST-AIRA2-LLM-004 lets a project override take precedence over a member\'s personal default, and rejects a non-owner override attempt', async () => {
    const anthropicAdapter = fakeAdapter('anthropic', 'personal default');
    const openaiAdapter = fakeAdapter('openai', 'project override');
    const gateway = new LlmBackendGateway({ anthropic: anthropicAdapter, openai: openaiAdapter });

    gateway.setUserDefaultBackend(actor('member-1'), 'anthropic');

    const ownerRoles = new Map<string, 'owner' | 'editor'>([['owner-1', 'owner'], ['member-1', 'editor']]);
    const authorizeProject = (accountId: string) => (_projectId: string, action: string) => {
      if (action === 'llmbackend.project-override.modify') {
        return ownerRoles.get(accountId) === 'owner';
      }
      return true;
    };

    expect(() =>
      gateway.setProjectBackendOverride(
        actor('member-1', { authorizeProject: authorizeProject('member-1') }),
        'project-1',
        'openai',
      ),
    ).toThrow(LlmAuthorizationDeniedError);

    gateway.setProjectBackendOverride(
      actor('owner-1', { authorizeProject: authorizeProject('owner-1') }),
      'project-1',
      'openai',
    );

    const memberResult = await gateway.chat(
      actor('member-1', { authorizeProject: authorizeProject('member-1') }),
      'project-1',
      REQUEST,
    );
    expect(memberResult.providerId).toBe('openai');
  });
});

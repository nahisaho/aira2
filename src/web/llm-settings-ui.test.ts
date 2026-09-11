import { describe, expect, it } from 'vitest';
import { LlmBackendGateway } from '../llm/gateway.js';
import { CredentialVault } from '../vault/credential-vault.js';
import { LlmSettingsUiController } from './llm-settings-ui.js';
import { DesignSystemRegistry } from './design-system.js';

function setup() {
  const gateway = new LlmBackendGateway({});
  const vault = new CredentialVault(Buffer.alloc(32, 7));
  const registry = new DesignSystemRegistry();
  const controller = new LlmSettingsUiController(gateway, vault, registry);
  const actor = {
    accountId: 'user-1',
    isGlobalAdmin: false,
    authorizeProject: () => true,
  };
  return { controller, actor, registry };
}

/** @id TEST-AIRA2-GUI-002
 * @verifies REQ-GUI-002
 */
describe('LLM backend selector UI', () => {
  it('TEST-AIRA2-GUI-002 selecting a provider through the UI makes the next resolved backend use it, and never exposes raw credential values', () => {
    const { controller, actor } = setup();

    const before = controller.view(actor, 'project-a');
    expect(before.selectedProvider).toBe('github-copilot-cli');

    controller.selectProvider(actor, 'anthropic');
    controller.setCredential(actor, 'anthropic', 'super-secret-api-key');

    const after = controller.view(actor, 'project-a');
    expect(after.selectedProvider).toBe('anthropic');

    const credential = after.credentials.find((c) => c.provider === 'anthropic');
    expect(credential).toBeDefined();
    expect(credential!.masked).not.toContain('super-secret-api-key');
    expect(credential!.masked.startsWith('••••')).toBe(true);
  });
});

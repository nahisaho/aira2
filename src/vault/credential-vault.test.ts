import { describe, expect, it } from 'vitest';
import { CredentialVault, type VaultActorContext } from './credential-vault.js';

const TEST_KEY = Buffer.alloc(32, 7);

function actor(accountId: string, opts: Partial<Omit<VaultActorContext, 'accountId'>> = {}): VaultActorContext {
  return {
    accountId,
    isGlobalAdmin: opts.isGlobalAdmin ?? false,
    authorizeProject: opts.authorizeProject ?? (() => true),
  };
}

/** @id TEST-AIRA2-VAULT-001
 * @verifies REQ-LLMBACKEND-003
 */
describe('administrator shared credentials', () => {
  it('TEST-AIRA2-VAULT-001 falls back to the admin shared credential when a user has no personal override, and rejects a non-admin write', () => {
    const vault = new CredentialVault(TEST_KEY);
    const admin = actor('admin-1', { isGlobalAdmin: true });
    const nonAdmin = actor('user-1', { isGlobalAdmin: false });

    expect(() => vault.setAdminSharedCredential(nonAdmin, 'openai', 'sk-shared-secret')).toThrow();

    vault.setAdminSharedCredential(admin, 'openai', 'sk-shared-secret');
    const resolved = vault.getCredentialForRequest(actor('user-1'), 'project-1', 'openai');
    expect(resolved).toBe('sk-shared-secret');
  });
});

/** @id TEST-AIRA2-VAULT-002
 * @verifies REQ-LLMBACKEND-004
 */
describe('per-user credential override', () => {
  it('TEST-AIRA2-VAULT-002 authenticates with the user\'s own credential instead of the admin shared one once registered', () => {
    const vault = new CredentialVault(TEST_KEY);
    const admin = actor('admin-1', { isGlobalAdmin: true });
    vault.setAdminSharedCredential(admin, 'openai', 'sk-shared-secret');

    const user = actor('user-1');
    vault.setUserOverrideCredential(user, 'openai', 'sk-personal-secret');

    const resolved = vault.getCredentialForRequest(user, 'project-1', 'openai');
    expect(resolved).toBe('sk-personal-secret');

    // Other users are unaffected and still fall back to the shared credential.
    const other = actor('user-2');
    expect(vault.getCredentialForRequest(other, 'project-1', 'openai')).toBe('sk-shared-secret');
  });
});

/** @id TEST-AIRA2-VAULT-003
 * @verifies REQ-LLMBACKEND-005
 */
describe('credential encryption at rest', () => {
  it('TEST-AIRA2-VAULT-003 never stores the plaintext credential value anywhere in the persisted store', () => {
    const vault = new CredentialVault(TEST_KEY);
    const admin = actor('admin-1', { isGlobalAdmin: true });
    const secret = 'sk-super-secret-value-12345';
    vault.setAdminSharedCredential(admin, 'anthropic', secret);
    vault.setUserOverrideCredential(actor('user-1'), 'anthropic', secret);

    const raw = JSON.stringify(vault.dumpRawStore());
    expect(raw).not.toContain(secret);

    // But the value must still be recoverable through the authorized read path.
    expect(vault.getCredentialForRequest(actor('user-1'), 'project-1', 'anthropic')).toBe(secret);
  });
});

/** @id TEST-AIRA2-VAULT-004
 * @verifies REQ-LLMBACKEND-007
 */
describe('credential masking on read', () => {
  it('TEST-AIRA2-VAULT-004 exposes only a masked value, never the plaintext, on any listing path', () => {
    const vault = new CredentialVault(TEST_KEY);
    const admin = actor('admin-1', { isGlobalAdmin: true });
    const secret = 'sk-listing-secret-value';
    vault.setAdminSharedCredential(admin, 'azure-openai', secret);
    vault.setUserOverrideCredential(actor('user-1'), 'azure-openai', secret);

    const projectEntries = vault.listProjectCredentials(actor('user-1'), 'project-1');
    expect(projectEntries.length).toBeGreaterThan(0);
    for (const entry of projectEntries) {
      expect(entry.masked).not.toBe(secret);
      expect(entry.masked).not.toContain(secret);
    }

    const selfEntries = vault.listSelfCredentials(actor('user-1'));
    expect(selfEntries.length).toBeGreaterThan(0);
    for (const entry of selfEntries) {
      expect(entry.masked).not.toBe(secret);
      expect(entry.masked).not.toContain(secret);
    }
  });
});

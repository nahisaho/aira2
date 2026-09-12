import { decryptSecret, encryptSecret, type EncryptedPayload } from './crypto.js';
import { authorizeSelf, type SelfScopeActorContext } from '../authz/self-scope.js';
import { SqliteStore } from '../server/store.js';

export type CredentialScope = 'admin-shared' | 'user-override';

export interface StoredCredential {
  id: string;
  provider: string;
  scope: CredentialScope;
  ownerAccountId: string | null;
  encrypted: EncryptedPayload;
  maskHint: string;
}

export interface MaskedCredentialEntry {
  id: string;
  provider: string;
  scope: CredentialScope;
  masked: string;
}

export interface VaultActorContext extends SelfScopeActorContext {
  authorizeProject(projectId: string, action: string): boolean;
}

export class VaultAuthorizationDeniedError extends Error {
  constructor(action: string) {
    super(`Vault authorization denied for action: ${action}`);
  }
}

const MASK_SUFFIX_LENGTH = 4;

function maskHintFor(secret: string): string {
  return secret.slice(-MASK_SUFFIX_LENGTH);
}

function maskedValueFor(cred: StoredCredential): string {
  return `••••${cred.maskHint}`;
}

/** @id CODE-AIRA2-VAULT-002
 * @implements REQ-LLMBACKEND-003 REQ-LLMBACKEND-004 REQ-LLMBACKEND-005 REQ-LLMBACKEND-007
 * @design DES-AIRA2-003
 */
export class CredentialVault {
  constructor(
    private readonly key: Buffer,
    private readonly store: SqliteStore = new SqliteStore({ dbPath: ':memory:' }),
  ) {}

  setAdminSharedCredential(actor: VaultActorContext, provider: string, secret: string): string {
    if (!authorizeSelf(actor, 'llmbackend.admin-credential.modify')) {
      throw new VaultAuthorizationDeniedError('llmbackend.admin-credential.modify');
    }
    const id = `admin:${provider}`;
    this.store.upsertCredential({
      id,
      provider,
      scope: 'admin-shared',
      ownerAccountId: null,
      encrypted: encryptSecret(secret, this.key) as unknown as Record<string, string>,
      maskHint: maskHintFor(secret),
    });
    return id;
  }

  setUserOverrideCredential(actor: VaultActorContext, provider: string, secret: string): string {
    if (!authorizeSelf(actor, 'credential.user-override.modify')) {
      throw new VaultAuthorizationDeniedError('credential.user-override.modify');
    }
    const id = `user:${actor.accountId}:${provider}`;
    this.store.upsertCredential({
      id,
      provider,
      scope: 'user-override',
      ownerAccountId: actor.accountId,
      encrypted: encryptSecret(secret, this.key) as unknown as Record<string, string>,
      maskHint: maskHintFor(secret),
    });
    return id;
  }

  getCredentialForRequest(actor: VaultActorContext, projectId: string, provider: string): string {
    if (!actor.authorizeProject(projectId, 'credential.project.use')) {
      throw new VaultAuthorizationDeniedError('credential.project.use');
    }
    const cred =
      this.store.getCredential(provider, 'user-override', actor.accountId) ??
      this.store.getCredential(provider, 'admin-shared', null);
    if (!cred) {
      throw new Error(`No credential configured for provider: ${provider}`);
    }
    return decryptSecret(cred.encrypted as unknown as EncryptedPayload, this.key);
  }

  listSelfCredentials(actor: VaultActorContext): MaskedCredentialEntry[] {
    if (!authorizeSelf(actor, 'credential.self.view')) {
      throw new VaultAuthorizationDeniedError('credential.self.view');
    }
    return this.store
      .listCredentials(actor.accountId)
      .map((cred) => ({
        id: cred.id,
        provider: cred.provider,
        scope: cred.scope as CredentialScope,
        masked: maskedValueFor(cred as unknown as StoredCredential),
      }));
  }

  listProjectCredentials(actor: VaultActorContext, projectId: string): MaskedCredentialEntry[] {
    if (!actor.authorizeProject(projectId, 'credential.project.view')) {
      throw new VaultAuthorizationDeniedError('credential.project.view');
    }
    return this.store.listCredentials(null).map((cred) => ({
      id: cred.id,
      provider: cred.provider,
      scope: cred.scope as CredentialScope,
      masked: maskedValueFor(cred as unknown as StoredCredential),
    }));
  }

  /** Test/inspection-only: raw persisted rows, used to prove no plaintext leaks. */
  dumpRawStore(): StoredCredential[] {
    return this.store.listCredentials() as unknown as StoredCredential[];
  }

  hasAdminSharedCredential(provider: string): boolean {
    return this.store.hasAdminCredential(provider);
  }
}

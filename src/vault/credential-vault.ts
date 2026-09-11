import { decryptSecret, encryptSecret, type EncryptedPayload } from './crypto.js';
import { authorizeSelf, type SelfScopeActorContext } from '../authz/self-scope.js';

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
  private readonly adminShared = new Map<string, StoredCredential>();
  private readonly userOverrides = new Map<string, StoredCredential>();

  constructor(private readonly key: Buffer) {}

  setAdminSharedCredential(actor: VaultActorContext, provider: string, secret: string): string {
    if (!authorizeSelf(actor, 'llmbackend.admin-credential.modify')) {
      throw new VaultAuthorizationDeniedError('llmbackend.admin-credential.modify');
    }
    const id = `admin:${provider}`;
    this.adminShared.set(provider, {
      id,
      provider,
      scope: 'admin-shared',
      ownerAccountId: null,
      encrypted: encryptSecret(secret, this.key),
      maskHint: maskHintFor(secret),
    });
    return id;
  }

  setUserOverrideCredential(actor: VaultActorContext, provider: string, secret: string): string {
    if (!authorizeSelf(actor, 'credential.user-override.modify')) {
      throw new VaultAuthorizationDeniedError('credential.user-override.modify');
    }
    const id = `user:${actor.accountId}:${provider}`;
    this.userOverrides.set(`${actor.accountId}:${provider}`, {
      id,
      provider,
      scope: 'user-override',
      ownerAccountId: actor.accountId,
      encrypted: encryptSecret(secret, this.key),
      maskHint: maskHintFor(secret),
    });
    return id;
  }

  getCredentialForRequest(actor: VaultActorContext, projectId: string, provider: string): string {
    if (!actor.authorizeProject(projectId, 'credential.project.use')) {
      throw new VaultAuthorizationDeniedError('credential.project.use');
    }
    const cred =
      this.userOverrides.get(`${actor.accountId}:${provider}`) ?? this.adminShared.get(provider);
    if (!cred) {
      throw new Error(`No credential configured for provider: ${provider}`);
    }
    return decryptSecret(cred.encrypted, this.key);
  }

  listSelfCredentials(actor: VaultActorContext): MaskedCredentialEntry[] {
    if (!authorizeSelf(actor, 'credential.self.view')) {
      throw new VaultAuthorizationDeniedError('credential.self.view');
    }
    return [...this.userOverrides.values()]
      .filter((cred) => cred.ownerAccountId === actor.accountId)
      .map((cred) => ({
        id: cred.id,
        provider: cred.provider,
        scope: cred.scope,
        masked: maskedValueFor(cred),
      }));
  }

  listProjectCredentials(actor: VaultActorContext, projectId: string): MaskedCredentialEntry[] {
    if (!actor.authorizeProject(projectId, 'credential.project.view')) {
      throw new VaultAuthorizationDeniedError('credential.project.view');
    }
    return [...this.adminShared.values()].map((cred) => ({
      id: cred.id,
      provider: cred.provider,
      scope: cred.scope,
      masked: maskedValueFor(cred),
    }));
  }

  /** Test/inspection-only: raw persisted rows, used to prove no plaintext leaks. */
  dumpRawStore(): StoredCredential[] {
    return [...this.adminShared.values(), ...this.userOverrides.values()];
  }
}

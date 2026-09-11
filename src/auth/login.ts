import { createAccount, type Account } from './account.js';
import { createSession, type Session } from './session.js';

export const KNOWN_AUTH_METHODS = ['github-oauth', 'password', 'oidc'] as const;
export type AuthMethod = (typeof KNOWN_AUTH_METHODS)[number];

export interface DeploymentAuthConfig {
  enabledMethods: readonly AuthMethod[];
}

export interface AuthProvider {
  method: AuthMethod;
  resolveExternalIdentity(credentials: unknown): string;
}

export class UnsupportedAuthMethodError extends Error {
  constructor(method: string) {
    super(`Unsupported authentication method: ${method}`);
  }
}

export class AuthMethodDisabledError extends Error {
  constructor(method: string) {
    super(`Authentication method disabled for this deployment: ${method}`);
  }
}

/** @id CODE-AIRA2-AUTH-003
 * @implements REQ-MULTIUSER-007
 * @design DES-AIRA2-001
 */
export function listSelectableAuthMethods(config: DeploymentAuthConfig): AuthMethod[] {
  return [...config.enabledMethods];
}

/** @id CODE-AIRA2-AUTH-004
 * @implements REQ-MULTIUSER-001
 * @design DES-AIRA2-001
 */
export function authenticate(
  config: DeploymentAuthConfig,
  providers: AuthProvider[],
  method: string,
  credentials: unknown,
  accounts: Map<string, Account>,
): Session {
  if (!(KNOWN_AUTH_METHODS as readonly string[]).includes(method)) {
    throw new UnsupportedAuthMethodError(method);
  }
  const knownMethod = method as AuthMethod;
  if (!config.enabledMethods.includes(knownMethod)) {
    throw new AuthMethodDisabledError(knownMethod);
  }
  const provider = providers.find((p) => p.method === knownMethod);
  if (!provider) {
    throw new UnsupportedAuthMethodError(knownMethod);
  }
  const externalIdentity = provider.resolveExternalIdentity(credentials);
  let account = accounts.get(externalIdentity);
  if (!account) {
    account = createAccount({ displayName: externalIdentity, externalIdentity });
    accounts.set(externalIdentity, account);
  }
  return createSession(account);
}

import { createAccount, type Account } from './account.js';
import { createSession, type Session } from './session.js';

export const KNOWN_AUTH_METHODS = ['github-oauth', 'password', 'oidc'] as const;
export type AuthMethod = (typeof KNOWN_AUTH_METHODS)[number];

export interface DeploymentAuthConfig {
  enabledMethods: readonly AuthMethod[];
}

export interface AccountDirectory {
  get(externalIdentity: string): Account | undefined;
  set(externalIdentity: string, account: Account): unknown;
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

export class InvalidCredentialsError extends Error {
  constructor(message = 'Invalid username or password') {
    super(message);
  }
}

export class AuthMethodNotImplementedError extends Error {
  constructor(method: AuthMethod) {
    super(`Authentication method '${method}' is not implemented for this release`);
  }
}

export class MfaRequiredError extends Error {
  constructor() {
    super('A valid TOTP code is required to complete login');
  }
}

export class StaleCredentialVersionLoginError extends Error {
  constructor() {
    super('Credential changed during login verification; please try again');
  }
}

/**
 * Pluggable extension implemented by DES-AIRA2-014 and registered at composition-root startup;
 * DES-AIRA2-001 does not depend on DES-AIRA2-014 directly to avoid a dependency cycle
 * (REQ-MULTIUSER-035).
 */
export interface MfaCheck {
  isRequired(accountId: string): boolean;
  verify(accountId: string, code: string, now?: number): 'valid' | 'invalid' | 'locked';
}

/**
 * Pluggable extension implemented by DES-AIRA2-015 and registered at composition-root startup;
 * DES-AIRA2-001 does not depend on DES-AIRA2-015 directly to avoid a dependency cycle
 * (REQ-MULTIUSER-046/047/048/050).
 */
export interface SessionIssuer {
  getCredentialVersion(accountId: string): number;
  issueSessionIfEligible(
    accountId: string,
    versionAtVerification: number,
    mfaSatisfied: boolean,
    now?: number,
  ): Session | { status: 'stale-version' } | { status: 'mfa-required' };
}

export interface LoginExtensions {
  mfaCheck?: MfaCheck;
  sessionIssuer?: SessionIssuer;
  /** Submitted TOTP code, if any; read only when `mfaCheck.isRequired` is true. */
  totpCode?: string;
}


/** @id CODE-AIRA2-AUTH-003
 * @implements REQ-MULTIUSER-007
 * @design DES-AIRA2-001
 */
export function listSelectableAuthMethods(config: DeploymentAuthConfig): AuthMethod[] {
  return [...config.enabledMethods];
}

/** @id CODE-AIRA2-AUTH-004
 * @implements REQ-MULTIUSER-001 REQ-MULTIUSER-035
 * @design DES-AIRA2-001
 */
export function authenticate(
  config: DeploymentAuthConfig,
  providers: AuthProvider[],
  method: string,
  credentials: unknown,
  accounts: AccountDirectory,
  extensions: LoginExtensions = {},
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

  const { mfaCheck, sessionIssuer, totpCode } = extensions;
  if (!sessionIssuer) {
    return createSession(account);
  }

  // Credential verification (password/OAuth/OIDC resolution above) has just succeeded; capture
  // the credential version at this moment so `issueSessionIfEligible` can atomically detect a
  // change that happened before session issuance (REQ-MULTIUSER-050).
  const versionAtVerification = sessionIssuer.getCredentialVersion(account.id);

  let mfaSatisfied = true;
  if (mfaCheck && mfaCheck.isRequired(account.id)) {
    if (!totpCode || mfaCheck.verify(account.id, totpCode) !== 'valid') {
      throw new MfaRequiredError();
    }
    mfaSatisfied = true;
  }

  const outcome = sessionIssuer.issueSessionIfEligible(account.id, versionAtVerification, mfaSatisfied);
  if ('status' in outcome) {
    if (outcome.status === 'mfa-required') {
      throw new MfaRequiredError();
    }
    throw new StaleCredentialVersionLoginError();
  }
  return outcome;
}

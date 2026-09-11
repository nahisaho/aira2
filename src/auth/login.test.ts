import { describe, expect, it } from 'vitest';
import {
  authenticate,
  AuthMethodDisabledError,
  listSelectableAuthMethods,
  UnsupportedAuthMethodError,
  type AuthProvider,
} from './login.js';
import type { Account } from './account.js';

const providers: AuthProvider[] = [
  { method: 'github-oauth', resolveExternalIdentity: (c) => `github:${c as string}` },
  { method: 'password', resolveExternalIdentity: (c) => `password:${(c as { email: string }).email}` },
  { method: 'oidc', resolveExternalIdentity: (c) => `oidc:${c as string}` },
];

/** @id TEST-AIRA2-AUTH-003
 * @verifies REQ-MULTIUSER-007
 */
describe('listSelectableAuthMethods', () => {
  it('TEST-AIRA2-AUTH-003 offers exactly the enabled methods for a deployment and rejects a disabled method at login', () => {
    const config = { enabledMethods: ['github-oauth', 'password'] as const };
    const accounts = new Map<string, Account>();

    expect(listSelectableAuthMethods(config)).toEqual(['github-oauth', 'password']);
    expect(listSelectableAuthMethods(config)).not.toContain('oidc');

    expect(() => authenticate(config, providers, 'oidc', 'someone', accounts)).toThrow(
      AuthMethodDisabledError,
    );
  });
});

/** @id TEST-AIRA2-AUTH-004
 * @verifies REQ-MULTIUSER-001
 */
describe('authenticate', () => {
  it('TEST-AIRA2-AUTH-004 issues a valid session through each of the three configured methods and rejects an unsupported method', () => {
    const config = { enabledMethods: ['github-oauth', 'password', 'oidc'] as const };
    const accounts = new Map<string, Account>();

    const githubSession = authenticate(config, providers, 'github-oauth', 'alice', accounts);
    expect(githubSession.accountId).toBe('github:alice');
    expect(githubSession.expiresAt).toBeGreaterThan(githubSession.issuedAt);

    const passwordSession = authenticate(
      config,
      providers,
      'password',
      { email: 'bob@example.com' },
      accounts,
    );
    expect(passwordSession.accountId).toBe('password:bob@example.com');

    const oidcSession = authenticate(config, providers, 'oidc', 'carol', accounts);
    expect(oidcSession.accountId).toBe('oidc:carol');

    // Re-authenticating the same identity reuses the same account rather than duplicating it.
    const githubSessionAgain = authenticate(config, providers, 'github-oauth', 'alice', accounts);
    expect(githubSessionAgain.accountId).toBe(githubSession.accountId);
    expect(accounts.size).toBe(3);

    expect(() => authenticate(config, providers, 'ldap', 'dave', accounts)).toThrow(
      UnsupportedAuthMethodError,
    );
  });
});

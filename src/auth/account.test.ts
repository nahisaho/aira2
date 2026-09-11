import { describe, expect, it } from 'vitest';
import { canSign, createAccount, isAdmin } from './account.js';

/** @id TEST-AIRA2-AUTH-001
 * @verifies REQ-MULTIUSER-002
 */
describe('createAccount', () => {
  it('TEST-AIRA2-AUTH-001 assigns exactly one role, defaulting to member, and admin-gated actions require the admin role', () => {
    const member = createAccount({ displayName: 'Alice', externalIdentity: 'github:alice' });
    expect(member.role).toBe('member');
    expect(isAdmin(member)).toBe(false);

    const admin = createAccount({
      displayName: 'Bob',
      externalIdentity: 'github:bob',
      role: 'admin',
    });
    expect(admin.role).toBe('admin');
    expect(isAdmin(admin)).toBe(true);

    // Role is exactly one of the two allowed values — never both, never neither.
    expect(['admin', 'member']).toContain(member.role);
    expect(['admin', 'member']).toContain(admin.role);
  });
});

/** @id TEST-AIRA2-AUTH-002
 * @verifies REQ-MULTIUSER-010
 */
describe('canSign', () => {
  it('TEST-AIRA2-AUTH-002 rejects shared, service, and unassigned accounts; allows an account uniquely bound to one natural person', () => {
    const shared = createAccount({
      displayName: 'Shared Lab Account',
      externalIdentity: 'password:lab-shared',
      isShared: true,
      assignedPersonId: 'person-1',
    });
    expect(canSign(shared)).toBe(false);

    const service = createAccount({
      displayName: 'CI Bot',
      externalIdentity: 'password:ci-bot',
      isServiceAccount: true,
    });
    expect(canSign(service)).toBe(false);

    const unassigned = createAccount({
      displayName: 'Pending User',
      externalIdentity: 'oidc:pending',
    });
    expect(canSign(unassigned)).toBe(false);

    const soleSigner = createAccount({
      displayName: 'Carol',
      externalIdentity: 'github:carol',
      assignedPersonId: 'person-2',
    });
    expect(canSign(soleSigner)).toBe(true);
  });
});

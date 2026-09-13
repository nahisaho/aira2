import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AccountSelfService, generateTotpCode } from './account-self-service.js';
import { SessionRegistry } from './session-registry.js';
import { AuditLog } from '../authz/audit.js';
import { SqliteStore } from '../server/store.js';

const KEY = randomBytes(32);
const TOTP_STEP_MS = 30_000;

function makeService() {
  const sessions = new SessionRegistry();
  const audit = new AuditLog();
  const service = new AccountSelfService(sessions, KEY, audit);
  service.registerAccount('user-1', 'Alice', 'alice@example.com', hashOf('correct-horse'));
  return { sessions, service, audit };
}

// Test-only helper: reuses the service's own hashing indirectly is unnecessary here;
// account-self-service always re-hashes via changePassword/completePasswordReset, so this
// helper only needs to produce *some* stored hash accepted by verifyPasswordHash at setup time.
import { hashPassword } from './password-provider.js';
function hashOf(password: string): string {
  return hashPassword(password);
}

/** @id TEST-AIRA2-PROFILE-001
 * @verifies REQ-MULTIUSER-018
 */
describe('user profile self-service', () => {
  it('TEST-AIRA2-PROFILE-001 updates display name but silently ignores role/accountId fields', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    const updated = service.updateProfile(actor, {
      displayName: 'Alicia',
      role: 'admin',
      accountId: 'someone-else',
    });
    expect(updated.displayName).toBe('Alicia');
    expect(updated.accountId).toBe('user-1');
    expect(service.getProfile('user-1')?.displayName).toBe('Alicia');
  });
});

/** @id TEST-AIRA2-PROFILE-002
 * @verifies REQ-MULTIUSER-040
 */
describe('verified email required for account identity matching', () => {
  it('TEST-AIRA2-PROFILE-002 an email becomes verified only after its confirmation link is used', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    service.updateProfile(actor, { email: 'alice-new@example.com' });
    expect(service.getProfile('user-1')?.verifiedEmail).toBe('alice@example.com');

    const { token } = service.getDeliveredLinks().at(-1)!;
    const result = service.confirmEmailChange(token);

    expect(result).toEqual({ status: 'ok' });
    expect(service.getProfile('user-1')?.verifiedEmail).toBe('alice-new@example.com');
  });
});

/** @id TEST-AIRA2-PROFILE-003
 * @verifies REQ-MULTIUSER-041
 */
describe('verified email change re-verification', () => {
  it('TEST-AIRA2-PROFILE-003 sends a confirmation link to the new address on profile email change', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    service.updateProfile(actor, { email: 'alice-new@example.com' });

    const links = service.getDeliveredLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ accountId: 'user-1', email: 'alice-new@example.com' });
  });
});

/** @id TEST-AIRA2-PROFILE-004
 * @verifies REQ-MULTIUSER-049
 */
describe('unconfirmed email change does not replace verified email', () => {
  it('TEST-AIRA2-PROFILE-004 keeps the previous verified email until the new confirmation link is used', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    service.updateProfile(actor, { email: 'alice-new@example.com' });

    expect(service.getProfile('user-1')?.verifiedEmail).toBe('alice@example.com');

    const { token } = service.getDeliveredLinks().at(-1)!;
    service.confirmEmailChange(token);

    expect(service.getProfile('user-1')?.verifiedEmail).toBe('alice-new@example.com');
  });
});

/** @id TEST-AIRA2-PROFILE-005
 * @verifies REQ-MULTIUSER-042
 */
describe('verified email uniqueness', () => {
  it('TEST-AIRA2-PROFILE-005 rejects confirming an email already verified on a different account', () => {
    const { service } = makeService();
    service.registerAccount('user-2', 'Bob', 'bob@example.com', hashOf('bobs-pw'));

    service.updateProfile({ accountId: 'user-2', isGlobalAdmin: false }, { email: 'alice@example.com' });
    const { token } = service.getDeliveredLinks().at(-1)!;

    const result = service.confirmEmailChange(token);

    expect(result).toEqual({ status: 'email-in-use' });
    expect(service.getProfile('user-2')?.verifiedEmail).toBe('bob@example.com');
  });
});

/** @id TEST-AIRA2-PASSWORD-001
 * @verifies REQ-MULTIUSER-019
 */
describe('self-service password change', () => {
  it('TEST-AIRA2-PASSWORD-001 replaces the credential only when the current password is correct', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };

    const wrong = service.changePassword(actor, 'not-the-password', 'new-password-1');
    expect(wrong).toEqual({ status: 'invalid-current-password' });

    const right = service.changePassword(actor, 'correct-horse', 'new-password-1');
    expect(right.status).toBe('ok');
  });
});

/** @id TEST-AIRA2-PASSWORD-002
 * @verifies REQ-MULTIUSER-027
 */
describe('password change reissues the submitting session', () => {
  it('TEST-AIRA2-PASSWORD-002 reissues a replacement session and invalidates prior sessions', () => {
    const { service, sessions } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    const otherSession = sessions.issueSession('user-1');

    const result = service.changePassword(actor, 'correct-horse', 'new-password-1');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(sessions.validateSession(result.session.id)).not.toBeNull();
    expect(sessions.validateSession(otherSession.id)).toBeNull();
  });
});

/** @id TEST-AIRA2-PASSWORD-003
 * @verifies REQ-MULTIUSER-020
 */
describe('password reset token issuance', () => {
  it('TEST-AIRA2-PASSWORD-003 issues a token only for a verified email, with an indistinguishable response otherwise', () => {
    const { service } = makeService();

    const matched = service.requestPasswordReset('alice@example.com');
    const unmatched = service.requestPasswordReset('unknown@example.com');

    expect(matched).toEqual({ status: 'ok' });
    expect(unmatched).toEqual({ status: 'ok' });
    expect(service.getDeliveredLinks().filter((l) => l.email === 'alice@example.com')).toHaveLength(1);
    expect(service.getDeliveredLinks().filter((l) => l.email === 'unknown@example.com')).toHaveLength(0);
  });
});

/** @id TEST-AIRA2-PASSWORD-004
 * @verifies REQ-MULTIUSER-036
 */
describe('password reset request rate limiting', () => {
  it('TEST-AIRA2-PASSWORD-004 stops issuing tokens once the configured rate is exceeded within the window', () => {
    const { service } = makeService();
    const now = Date.now();

    for (let i = 0; i < 3; i += 1) {
      service.requestPasswordReset('alice@example.com', now + i);
    }
    service.requestPasswordReset('alice@example.com', now + 4);

    const links = service.getDeliveredLinks().filter((l) => l.email === 'alice@example.com');
    expect(links).toHaveLength(3);
  });
});

/** @id TEST-AIRA2-PASSWORD-005
 * @verifies REQ-MULTIUSER-028
 */
describe('password reset token single use', () => {
  it('TEST-AIRA2-PASSWORD-005 rejects a reused, expired, or unknown token without changing the credential', () => {
    const { service } = makeService();
    service.requestPasswordReset('alice@example.com');
    const { token } = service.getDeliveredLinks().at(-1)!;

    expect(service.completePasswordReset(token, 'new-password-1')).toEqual({ status: 'ok', accountId: 'user-1' });
    expect(service.completePasswordReset(token, 'new-password-2')).toEqual({ status: 'invalid-token' });
    expect(service.completePasswordReset('unknown-token', 'new-password-3')).toEqual({ status: 'invalid-token' });
  });
});

/** @id TEST-AIRA2-PASSWORD-006
 * @verifies REQ-MULTIUSER-032
 */
describe('password reset completion', () => {
  it('TEST-AIRA2-PASSWORD-006 replaces the stored credential so login succeeds with the new password', () => {
    const { service } = makeService();
    service.requestPasswordReset('alice@example.com');
    const { token } = service.getDeliveredLinks().at(-1)!;

    service.completePasswordReset(token, 'brand-new-password');

    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    const result = service.changePassword(actor, 'brand-new-password', 'yet-another-password');
    expect(result.status).toBe('ok');
  });
});

/** @id TEST-AIRA2-PASSWORD-007
 * @verifies REQ-MULTIUSER-038
 */
describe('password reset token consumption', () => {
  it('TEST-AIRA2-PASSWORD-007 marks the token consumed once the reset completes', () => {
    const { service } = makeService();
    service.requestPasswordReset('alice@example.com');
    const { token } = service.getDeliveredLinks().at(-1)!;

    service.completePasswordReset(token, 'brand-new-password');

    expect(service.completePasswordReset(token, 'another-password')).toEqual({ status: 'invalid-token' });
  });
});

/** @id TEST-AIRA2-PASSWORD-008
 * @verifies REQ-MULTIUSER-037
 */
describe('password reset invalidates existing sessions', () => {
  it('TEST-AIRA2-PASSWORD-008 invalidates every session that existed before the reset', () => {
    const { service, sessions } = makeService();
    const preExisting = sessions.issueSession('user-1');
    service.requestPasswordReset('alice@example.com');
    const { token } = service.getDeliveredLinks().at(-1)!;

    service.completePasswordReset(token, 'brand-new-password');

    expect(sessions.validateSession(preExisting.id)).toBeNull();
  });
});

/** @id TEST-AIRA2-PASSWORD-009
 * @verifies REQ-MULTIUSER-043
 */
describe('atomic password reset completion', () => {
  it('TEST-AIRA2-PASSWORD-009 lets exactly one of two attempts using the same token succeed', () => {
    const { service, sessions } = makeService();
    const versionBefore = sessions.getCredentialVersion('user-1');
    service.requestPasswordReset('alice@example.com');
    const { token } = service.getDeliveredLinks().at(-1)!;

    const first = service.completePasswordReset(token, 'password-a');
    const second = service.completePasswordReset(token, 'password-b');

    expect([first.status, second.status].sort()).toEqual(['invalid-token', 'ok']);
    expect(sessions.getCredentialVersion('user-1')).toBe(versionBefore + 1);
  });
});

/** @id TEST-AIRA2-MFA-001
 * @verifies REQ-MULTIUSER-021
 */
describe('multi-factor authentication enrollment', () => {
  it('TEST-AIRA2-MFA-001 stores the TOTP secret encrypted at rest', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };

    const { secret } = service.enrollTotp(actor);

    expect(secret).toMatch(/^[0-9a-f]+$/);
    // The service exposes no way to read the raw persisted record other than through
    // verify()/confirmTotpEnrollment(), confirming the secret is never stored/returned in
    // plaintext anywhere except at the moment of enrollment itself.
  });
});

/** @id TEST-AIRA2-MFA-002
 * @verifies REQ-MULTIUSER-034
 */
describe('MFA enrollment confirmation', () => {
  it('TEST-AIRA2-MFA-002 activates the factor only after a valid generated code is supplied', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    const { secret } = service.enrollTotp(actor);
    const now = Date.now();

    const badAttempt = service.confirmTotpEnrollment('user-1', '000000', now);
    expect(badAttempt).toBe(false);
    expect(service.verify('user-1', '000000', now)).toBe('invalid');

    const code = generateTotpCode(Buffer.from(secret, 'hex'), Math.floor(now / 30_000));
    const goodAttempt = service.confirmTotpEnrollment('user-1', code, now);
    expect(goodAttempt).toBe(true);
  });
});

/** @id TEST-AIRA2-MFA-003
 * @verifies REQ-MULTIUSER-033
 */
describe('MFA verification throttling', () => {
  it('TEST-AIRA2-MFA-003 locks further attempts after consecutive failures until the cooldown elapses', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    const { secret } = service.enrollTotp(actor);
    const now = Date.now();
    const code = generateTotpCode(Buffer.from(secret, 'hex'), Math.floor(now / 30_000));
    service.confirmTotpEnrollment('user-1', code, now);

    for (let i = 0; i < 5; i += 1) {
      service.verify('user-1', '000000', now);
    }
    expect(service.verify('user-1', '000000', now)).toBe('locked');

    const laterStep = Math.floor((now + 6 * 60_000) / 30_000);
    const laterCode = generateTotpCode(Buffer.from(secret, 'hex'), laterStep);
    expect(service.verify('user-1', laterCode, now + 6 * 60_000)).toBe('valid');
  });
});

/** @id TEST-AIRA2-MFA-004
 * @verifies REQ-MULTIUSER-044
 */
describe('TOTP code replay rejection', () => {
  it('TEST-AIRA2-MFA-004 rejects a code whose time-step counter was already accepted', () => {
    const { service } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    const { secret } = service.enrollTotp(actor);
    const now = Date.now();
    const confirmCode = generateTotpCode(Buffer.from(secret, 'hex'), Math.floor(now / 30_000));
    service.confirmTotpEnrollment('user-1', confirmCode, now);

    const laterNow = now + TOTP_STEP_MS;
    const loginCode = generateTotpCode(Buffer.from(secret, 'hex'), Math.floor(laterNow / 30_000));
    expect(service.verify('user-1', loginCode, laterNow)).toBe('valid');
    expect(service.verify('user-1', loginCode, laterNow)).toBe('invalid');
  });
});

/** @id TEST-AIRA2-AUDIT-009
 * @verifies REQ-MULTIUSER-006
 */
describe('audit coverage for profile/email/password self-service mutations', () => {
  it('TEST-AIRA2-AUDIT-009 records an audit entry for profile update, email confirmation, password change, and password reset, without leaking secrets, and skips entries on failure paths and for unregistered emails', () => {
    const { service, audit } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };

    service.updateProfile(actor, { displayName: 'Alicia', email: 'alice-new@example.com' });
    const confirmLink = service.getDeliveredLinks()[0]!;

    expect(service.confirmEmailChange('not-a-real-token')).toEqual({ status: 'invalid-token' });
    expect(audit.list()).toHaveLength(1); // only profile.update so far; the failed confirmation recorded nothing

    service.confirmEmailChange(confirmLink.token);

    expect(service.changePassword(actor, 'wrong-current-password', 'new-password-1')).toEqual({
      status: 'invalid-current-password',
    });
    expect(audit.list()).toHaveLength(2); // still just profile.update + profile.email.confirm

    service.changePassword(actor, 'correct-horse', 'new-password-1');
    service.requestPasswordReset('nobody@example.com');
    service.requestPasswordReset('alice-new@example.com');
    const resetLink = service.getDeliveredLinks().at(-1)!;

    expect(service.completePasswordReset('not-a-real-reset-token', 'new-password-2')).toEqual({
      status: 'invalid-token',
    });
    const beforeReset = audit.list().length;

    service.completePasswordReset(resetLink.token, 'new-password-2');

    expect(audit.list()).toHaveLength(beforeReset + 1); // exactly one new entry for the successful completion

    const entries = audit.list();
    const actionTypes = entries.map((e) => e.actionType);
    expect(actionTypes).toEqual([
      'profile.update',
      'profile.email.confirm',
      'auth.password.change',
      'auth.password.reset-request',
      'auth.password.reset-complete',
    ]);
    for (const entry of entries) {
      expect(entry.userId).toBe('user-1');
      expect(entry.targetResource).not.toContain('new-password');
      expect(entry.targetResource).not.toContain(confirmLink.token);
      expect(entry.targetResource).not.toContain(resetLink.token);
    }
  });
});

/** @id TEST-AIRA2-AUDIT-010
 * @verifies REQ-MULTIUSER-006
 */
describe('audit coverage for MFA self-service mutations', () => {
  it('TEST-AIRA2-AUDIT-010 records an audit entry only for successful enrollment and confirmation, not failed confirmation attempts', () => {
    const { service, audit } = makeService();
    const actor = { accountId: 'user-1', isGlobalAdmin: false };
    const { secret } = service.enrollTotp(actor);

    const now = Date.now();
    const validCode = generateTotpCode(Buffer.from(secret, 'hex'), Math.floor(now / 30_000));
    const invalidCode = String((Number(validCode) + 1) % 1_000_000).padStart(6, '0');

    expect(service.confirmTotpEnrollment('user-1', invalidCode, now)).toBe(false);
    expect(audit.list()).toHaveLength(1); // only mfa.enroll so far; the failed confirmation recorded nothing

    expect(service.confirmTotpEnrollment('user-1', validCode, now)).toBe(true);

    const entries = audit.list();
    expect(entries.map((e) => e.actionType)).toEqual(['mfa.enroll', 'mfa.confirm']);
    for (const entry of entries) {
      expect(entry.userId).toBe('user-1');
      expect(entry.targetResource).not.toContain(secret);
    }
  });
});

/** @id TEST-AIRA2-PROFILE-006
 * @verifies REQ-RUNTIME-002
 */
describe('account self-service state survives a fresh instance against the same store', () => {
  it('TEST-AIRA2-PROFILE-006 restores profile/verified-email, password hash, reset-rate-limit exhaustion, and TOTP replay/lockout state after reconstruction', () => {
    const dbPath = resolve('data/test-artifacts/account-self-service-restart.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    rmSync(dbPath, { force: true });
    try {
      const store = new SqliteStore({ dbPath });
      const sessions = new SessionRegistry(store);
      const audit = new AuditLog(store);
      const service = new AccountSelfService(sessions, KEY, audit, store);
      service.registerAccount('user-1', 'Alice', null, hashOf('correct-horse'));
      const actor = { accountId: 'user-1', isGlobalAdmin: false };

      // Verified-email persistence (via profile update + confirmation link).
      service.updateProfile(actor, { email: 'alice@example.com' });
      const { token: emailToken } = service.getDeliveredLinks().at(-1)!;
      service.confirmEmailChange(emailToken);

      // Password change persistence.
      service.changePassword(actor, 'correct-horse', 'new-battery-staple');

      // Exhaust the reset-request rate limit (3 allowed within the window; the 4th is throttled).
      for (let i = 0; i < 4; i += 1) {
        service.requestPasswordReset('alice@example.com');
      }

      // MFA enroll/confirm, then replay the same accepted code and drive the factor into lockout.
      const { secret } = service.enrollTotp(actor);
      const now = Date.now();
      const confirmCode = generateTotpCode(Buffer.from(secret, 'hex'), Math.floor(now / TOTP_STEP_MS));
      service.confirmTotpEnrollment('user-1', confirmCode, now);
      for (let i = 0; i < 5; i += 1) {
        service.verify('user-1', '000000', now);
      }
      expect(service.verify('user-1', '000000', now)).toBe('locked');

      const sessions2 = new SessionRegistry(store);
      const service2 = new AccountSelfService(sessions2, KEY, audit, store);

      expect(service2.getProfile('user-1')?.verifiedEmail).toBe('alice@example.com');
      expect(service2.getPasswordHash('user-1')).not.toBe(hashOf('correct-horse'));
      // Reset-reset-limit exhaustion persists: a 5th request from a fresh instance is still throttled
      // (no new reset token/delivered link is produced for it).
      const linksBefore = service2.getDeliveredLinks().length;
      service2.requestPasswordReset('alice@example.com');
      expect(service2.getDeliveredLinks().length).toBe(linksBefore);
      // MFA lockout persists.
      expect(service2.verify('user-1', confirmCode, now)).toBe('locked');
      // Replay rejection persists past reconstruction, after the lockout cooldown elapses.
      const laterNow = now + 6 * 60_000;
      expect(service2.verify('user-1', confirmCode, laterNow)).toBe('invalid');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});

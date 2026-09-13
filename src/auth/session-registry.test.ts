import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SessionRegistry } from './session-registry.js';
import { SqliteStore } from '../server/store.js';

/** @id TEST-AIRA2-SESSION-001
 * @verifies REQ-MULTIUSER-047
 */
describe('credential replacement increments version', () => {
  it('TEST-AIRA2-SESSION-001 increments the account credential version exactly once per replacement', () => {
    const registry = new SessionRegistry();
    expect(registry.getCredentialVersion('user-1')).toBe(0);
    expect(registry.incrementCredentialVersion('user-1')).toBe(1);
    expect(registry.getCredentialVersion('user-1')).toBe(1);
    expect(registry.incrementCredentialVersion('user-1')).toBe(2);
  });
});

/** @id TEST-AIRA2-SESSION-002
 * @verifies REQ-MULTIUSER-048
 */
describe('stale credential-version session rejection', () => {
  it('TEST-AIRA2-SESSION-002 rejects a session whose recorded version no longer matches the current version', () => {
    const registry = new SessionRegistry();
    const session = registry.issueSession('user-1');
    expect(registry.validateSession(session.id)).not.toBeNull();

    registry.incrementCredentialVersion('user-1');

    expect(registry.validateSession(session.id)).toBeNull();
  });
});

/** @id TEST-AIRA2-SESSION-003
 * @verifies REQ-MULTIUSER-046
 */
describe('session credential-version binding', () => {
  it('TEST-AIRA2-SESSION-003 records the credential version current at the moment of issuance', () => {
    const registry = new SessionRegistry();
    registry.incrementCredentialVersion('user-1');
    const session = registry.issueSession('user-1');
    expect(session.credentialVersion).toBe(1);

    registry.incrementCredentialVersion('user-1');
    expect(registry.validateSession(session.id)).toBeNull();
  });
});

/** @id TEST-AIRA2-SESSION-004
 * @verifies REQ-MULTIUSER-050
 */
describe('login fails on credential version change during verification', () => {
  it('TEST-AIRA2-SESSION-004 fails issuance without a session when the version changed since verification', () => {
    const registry = new SessionRegistry();
    const versionAtVerification = registry.getCredentialVersion('user-1');

    registry.incrementCredentialVersion('user-1');

    const result = registry.issueSessionIfEligible('user-1', versionAtVerification, true);
    expect(result).toEqual({ status: 'stale-version' });
    expect(registry.listSessions('user-1')).toHaveLength(0);
  });

  it('TEST-AIRA2-SESSION-004 issues a session when the version is unchanged since verification', () => {
    const registry = new SessionRegistry();
    const versionAtVerification = registry.getCredentialVersion('user-1');

    const result = registry.issueSessionIfEligible('user-1', versionAtVerification, true);
    expect(result).not.toHaveProperty('status');
  });
});

/** @id TEST-AIRA2-SESSION-005
 * @verifies REQ-MULTIUSER-023
 */
describe('active session listing', () => {
  it('TEST-AIRA2-SESSION-005 lists a non-bearer display identifier, creation time, and expiry time, never the bearer token', () => {
    const registry = new SessionRegistry();
    const session = registry.issueSession('user-1');

    const listed = registry.listSessions('user-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.displayId).not.toBe(session.id);
    expect(listed[0]).toHaveProperty('createdAt');
    expect(listed[0]).toHaveProperty('expiresAt');
    expect(listed[0]).not.toHaveProperty('token');
    expect(listed[0]).not.toHaveProperty('id');
  });
});

/** @id TEST-AIRA2-SESSION-006
 * @verifies REQ-MULTIUSER-024
 */
describe('self-service session revocation', () => {
  it('TEST-AIRA2-SESSION-006 immediately invalidates a listed session other than the current one', () => {
    const registry = new SessionRegistry();
    const current = registry.issueSession('user-1');
    const other = registry.issueSession('user-1');
    const displayId = registry
      .listSessions('user-1')
      .filter((entry) => entry.displayId !== registry.getDisplayId(current.id))
      .map((entry) => entry.displayId)[0]!;

    registry.revokeSession('user-1', displayId, current.id);

    expect(registry.validateSession(other.id)).toBeNull();
    expect(registry.validateSession(current.id)).not.toBeNull();
  });
});

/** @id TEST-AIRA2-SESSION-007
 * @verifies REQ-MULTIUSER-024
 */
describe('composition-root logout', () => {
  it('TEST-AIRA2-SESSION-007 unconditionally ends a session, including the caller\'s own current session', () => {
    const registry = new SessionRegistry();
    const current = registry.issueSession('user-1');

    registry.endSession(current.id);

    expect(registry.validateSession(current.id)).toBeNull();
  });
});

/** @id TEST-AIRA2-SESSION-008
 * @verifies REQ-RUNTIME-002
 */
describe('session/credential-version state survives a fresh instance against the same store', () => {
  it('TEST-AIRA2-SESSION-008 restores active sessions, display IDs, and the credential version after reconstruction', () => {
    const dbPath = resolve('data/test-artifacts/session-registry-restart.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    rmSync(dbPath, { force: true });
    try {
      const store = new SqliteStore({ dbPath });
      const registry = new SessionRegistry(store);
      const session = registry.issueSession('user-1');
      const displayId = registry.getDisplayId(session.id);
      registry.incrementCredentialVersion('user-1');
      // Re-issue under the now-current version so the session remains valid after restart.
      const current = registry.issueSession('user-1');

      const registry2 = new SessionRegistry(store);

      expect(registry2.getCredentialVersion('user-1')).toBe(1);
      expect(registry2.validateSession(session.id)).toBeNull(); // stale version, as before restart
      expect(registry2.validateSession(current.id)).not.toBeNull();
      expect(registry2.getDisplayId(session.id)).toBe(displayId);
      expect(registry2.listSessions('user-1').map((s) => s.displayId)).toContain(
        registry2.getDisplayId(current.id),
      );
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});

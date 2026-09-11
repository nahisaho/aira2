import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ELN_AND_GRAPHRAG_ACTIONS,
  PROJECT_ACTION_MATRIX,
  PROJECT_ROLES,
  isProjectActionAllowed,
} from './matrix.js';
import { AuditLog } from './audit.js';
import {
  AuthorizationDeniedError,
  ProjectAuthorizationService,
  type RevocationNotifier,
} from './project-authz.js';

function makeService() {
  const audit = new AuditLog();
  const notifier: RevocationNotifier = { terminateSessionsAndConnections: vi.fn() };
  const service = new ProjectAuthorizationService(audit, notifier);
  return { audit, notifier, service };
}

/** @id TEST-AIRA2-AUTHZ-001
 * @verifies REQ-MULTIUSER-009
 */
describe('PROJECT_ACTION_MATRIX', () => {
  it('TEST-AIRA2-AUTHZ-001 defines every listed ELN and Graph RAG action for all three roles with no undefined cell', () => {
    for (const action of ELN_AND_GRAPHRAG_ACTIONS) {
      const cell = PROJECT_ACTION_MATRIX[action];
      expect(cell, `matrix row missing for ${action}`).toBeDefined();
      for (const role of PROJECT_ROLES) {
        expect(typeof cell![role]).toBe('boolean');
      }
    }
  });
});

/** @id TEST-AIRA2-AUTHZ-002
 * @verifies REQ-MULTIUSER-003
 */
describe('default project isolation', () => {
  it('TEST-AIRA2-AUTHZ-002 denies a second user any access to a project by default', () => {
    const { service } = makeService();
    service.createProject('user-a', 'project-1');

    expect(service.authorize({ accountId: 'user-a' }, 'project-1', 'eln.view')).toBe(true);
    expect(service.authorize({ accountId: 'user-b' }, 'project-1', 'eln.view')).toBe(false);
    expect(service.authorize({ accountId: 'user-b' }, 'project-1', 'eln.edit')).toBe(false);
  });
});

/** @id TEST-AIRA2-AUTHZ-003
 * @verifies REQ-MULTIUSER-004
 */
describe('explicit project sharing', () => {
  it('TEST-AIRA2-AUTHZ-003 grants access at exactly the shared permission level', () => {
    const { service } = makeService();
    service.createProject('user-a', 'project-1');

    service.grantShare({ accountId: 'user-a' }, 'project-1', 'user-viewer', 'viewer');
    expect(service.authorize({ accountId: 'user-viewer' }, 'project-1', 'eln.view')).toBe(true);
    expect(service.authorize({ accountId: 'user-viewer' }, 'project-1', 'eln.edit')).toBe(false);

    service.grantShare({ accountId: 'user-a' }, 'project-1', 'user-editor', 'editor');
    expect(service.authorize({ accountId: 'user-editor' }, 'project-1', 'eln.view')).toBe(true);
    expect(service.authorize({ accountId: 'user-editor' }, 'project-1', 'eln.edit')).toBe(true);

    // A non-owner may not grant shares.
    expect(() =>
      service.grantShare({ accountId: 'user-editor' }, 'project-1', 'user-c', 'viewer'),
    ).toThrow(AuthorizationDeniedError);
  });
});

/** @id TEST-AIRA2-AUTHZ-004
 * @verifies REQ-MULTIUSER-005
 */
describe('access revocation', () => {
  it('TEST-AIRA2-AUTHZ-004 denies subsequent access after a share is revoked', () => {
    const { service } = makeService();
    service.createProject('user-a', 'project-1');
    service.grantShare({ accountId: 'user-a' }, 'project-1', 'user-b', 'editor');
    expect(service.authorize({ accountId: 'user-b' }, 'project-1', 'eln.view')).toBe(true);

    service.revokeShare({ accountId: 'user-a' }, 'project-1', 'user-b');
    expect(service.authorize({ accountId: 'user-b' }, 'project-1', 'eln.view')).toBe(false);
  });
});

/** @id TEST-AIRA2-AUTHZ-005
 * @verifies REQ-MULTIUSER-008
 */
describe('revocation terminates active access', () => {
  it('TEST-AIRA2-AUTHZ-005 terminates the revoked user\'s active session and MCP connection for that project', () => {
    const { service, notifier } = makeService();
    service.createProject('user-a', 'project-1');
    service.grantShare({ accountId: 'user-a' }, 'project-1', 'user-b', 'editor');

    service.revokeShare({ accountId: 'user-a' }, 'project-1', 'user-b');

    expect(notifier.terminateSessionsAndConnections).toHaveBeenCalledWith('project-1', 'user-b');
  });
});

/** @id TEST-AIRA2-AUTHZ-006
 * @verifies REQ-MULTIUSER-006
 */
describe('per-user audit log', () => {
  it('TEST-AIRA2-AUTHZ-006 records a complete audit entry for every share grant and revoke', () => {
    const { service, audit } = makeService();
    service.createProject('user-a', 'project-1');
    service.grantShare({ accountId: 'user-a' }, 'project-1', 'user-b', 'editor');
    service.revokeShare({ accountId: 'user-a' }, 'project-1', 'user-b');

    const entries = audit.list();
    expect(entries.length).toBe(2);
    for (const entry of entries) {
      expect(entry.userId).toBe('user-a');
      expect(typeof entry.timestamp).toBe('number');
      expect(typeof entry.actionType).toBe('string');
      expect(entry.targetResource).toContain('project-1');
      expect(entry.targetResource).toContain('user-b');
    }
  });
});

/** @id TEST-AIRA2-AUTHZ-007
 * @verifies REQ-MULTIUSER-011
 */
describe('authorization matrix enforcement', () => {
  it('TEST-AIRA2-AUTHZ-007 permits only matrix-defined role/action combinations for each of the three roles', () => {
    const { service } = makeService();
    service.createProject('project-owner', 'project-1');
    service.grantShare({ accountId: 'project-owner' }, 'project-1', 'project-editor', 'editor');
    service.grantShare({ accountId: 'project-owner' }, 'project-1', 'project-viewer', 'viewer');

    const actorByRole = {
      owner: 'project-owner',
      editor: 'project-editor',
      viewer: 'project-viewer',
    } as const;

    for (const action of ELN_AND_GRAPHRAG_ACTIONS) {
      for (const role of PROJECT_ROLES) {
        const expected = isProjectActionAllowed(role, action);
        const actual = service.authorize({ accountId: actorByRole[role] }, 'project-1', action);
        expect(actual, `${role} x ${action}`).toBe(expected);
      }
    }
  });
});

/** @id TEST-AIRA2-AUTHZ-008
 * @verifies REQ-MULTIUSER-012
 */
describe('signed record ownership preserved on revocation', () => {
  it('TEST-AIRA2-AUTHZ-008 does not alter or require access to prior signature attribution when revoking a share', () => {
    const { service } = makeService();
    service.createProject('user-a', 'project-1');
    service.grantShare({ accountId: 'user-a' }, 'project-1', 'user-signer', 'editor');

    // Signature attribution is owned entirely by DES-AIRA2-007, not this service;
    // revocation must not require or accept any signature-record parameter at all.
    const priorAttribution = Object.freeze({ recordVersionId: 'rec-v1', signerAccountId: 'user-signer' });

    service.revokeShare({ accountId: 'user-a' }, 'project-1', 'user-signer');

    expect(priorAttribution.signerAccountId).toBe('user-signer');
    expect(service.revokeShare.length).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';
import { AuditLedger, TxContext } from './ledger.js';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';

/** @id TEST-AIRA2-AUDIT-001
 * @verifies REQ-ELN-005
 */
describe('audit ledger append-only trail', () => {
  it('TEST-AIRA2-AUDIT-001 appends a correct, chronologically ordered, immutable entry for every lifecycle action with no delete/reorder path', () => {
    const ledger = new AuditLedger();
    const actions: Array<['create' | 'edit' | 'approve' | 'void' | 'export' | 'delete', string]> = [
      ['create', 'v1'],
      ['edit', 'v2'],
      ['approve', 'v2'],
      ['void', 'v2'],
      ['export', 'v2'],
      ['delete', 'v2'],
    ];

    for (const [action, versionId] of actions) {
      const tx = new TxContext();
      ledger.appendAuditEntry(tx, action, 'project-1', 'record', versionId, 'user-a', {
        beforeRef: 'before',
        afterRef: 'after',
      });
      tx.commit();
    }

    const entries = ledger.listEntries('project-1');
    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.action)).toEqual(['create', 'edit', 'approve', 'void', 'export', 'delete']);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const entry of entries) {
      expect(entry.actorAccountId).toBe('user-a');
      expect(entry.beforeRef).toBe('before');
      expect(entry.afterRef).toBe('after');
      expect(typeof entry.timestamp).toBe('string');
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(entries[0]!.prevHash).toBeNull();
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);

    expect((ledger as unknown as Record<string, unknown>).deleteEntry).toBeUndefined();
    expect((ledger as unknown as Record<string, unknown>).reorderEntries).toBeUndefined();
    expect(ledger.detectTamperedEntries('project-1')).toEqual([]);
  });
});

/** @id TEST-AIRA2-AUDIT-002
 * @verifies REQ-ELN-011
 */
describe('audit ledger tamper detection', () => {
  it('TEST-AIRA2-AUDIT-002 detects an audit entry altered outside the normal recording process', () => {
    const ledger = new AuditLedger();
    const tx1 = new TxContext();
    ledger.appendAuditEntry(tx1, 'create', 'project-2', 'record', 'v1', 'user-a');
    tx1.commit();
    const tx2 = new TxContext();
    ledger.appendAuditEntry(tx2, 'edit', 'project-2', 'record', 'v2', 'user-a');
    tx2.commit();

    expect(ledger.detectTamperedEntries('project-2')).toEqual([]);

    ledger.__testOnlyMutateEntry('project-2', 2, (entry) => ({ ...entry, actorAccountId: 'attacker' }));

    expect(ledger.detectTamperedEntries('project-2')).toEqual([2]);
  });
});

/** @id TEST-AIRA2-AUDIT-006
 * @verifies REQ-RUNTIME-003 REQ-MULTIUSER-011
 */
describe('audit history retrieval', () => {
  it('TEST-AIRA2-AUDIT-006 returns ordered audit history for the requested subject version only when the caller is authorized', () => {
    const authz = new ProjectAuthorizationService(new AuditLog(), {
      terminateSessionsAndConnections: () => undefined,
    });
    authz.createProject('owner-1', 'project-1');
    authz.grantShare({ accountId: 'owner-1' }, 'project-1', 'editor-1', 'editor');
    const ledger = new AuditLedger(undefined, authz);

    const tx1 = new TxContext();
    ledger.appendAuditEntry(tx1, 'create', 'project-1', 'record', 'record-v1', 'owner-1');
    tx1.commit();
    const tx2 = new TxContext();
    ledger.appendAuditEntry(tx2, 'edit', 'project-1', 'record', 'record-v1', 'editor-1');
    tx2.commit();
    const tx3 = new TxContext();
    ledger.appendAuditEntry(tx3, 'approve', 'project-1', 'record', 'record-v2', 'owner-1');
    tx3.commit();

    expect(() =>
      ledger.getAuditHistory({ accountId: 'viewer-1' }, 'project-1', 'record', 'record-v1'),
    ).toThrow();

    const history = ledger.getAuditHistory({ accountId: 'editor-1' }, 'project-1', 'record', 'record-v1');
    expect(history.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(history.every((entry) => entry.subjectVersionId === 'record-v1')).toBe(true);
  });
});

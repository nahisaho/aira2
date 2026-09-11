import { describe, expect, it } from 'vitest';
import { AuditLedger, TxContext } from './ledger.js';

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

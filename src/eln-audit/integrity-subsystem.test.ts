import { describe, expect, it } from 'vitest';
import { AuditLedger, TxContext } from './ledger.js';
import {
  ElnAuditIntegritySubsystem,
  TRUSTED_SCHEDULER_PRINCIPAL,
  type ElnAuditActorContext,
} from './integrity-subsystem.js';

function actor(accountId: string, canManage = true): ElnAuditActorContext {
  return {
    accountId,
    authorizeProject: () => canManage,
  };
}

/** @id TEST-AIRA2-AUDIT-003
 * @verifies REQ-ELN-013
 */
describe('scheduled integrity checks', () => {
  it('TEST-AIRA2-AUDIT-003 produces a retrievable report for a project only via the trusted scheduler principal, not an arbitrary actor', () => {
    const ledger = new AuditLedger();
    const subsystem = new ElnAuditIntegritySubsystem(ledger);
    const tx = new TxContext();
    ledger.appendAuditEntry(tx, 'create', 'project-3', 'record', 'v1', 'user-a');
    tx.commit();

    const report = subsystem.runIntegrityCheck(TRUSTED_SCHEDULER_PRINCIPAL, 'project-3');
    expect(report.projectId).toBe('project-3');
    expect(report.trigger).toBe('scheduled');
    expect(report.tampered).toBe(false);

    expect(() =>
      subsystem.runIntegrityCheck('not-the-scheduler' as unknown as typeof TRUSTED_SCHEDULER_PRINCIPAL, 'project-3'),
    ).toThrow();
  });
});

/** @id TEST-AIRA2-AUDIT-004
 * @verifies REQ-ELN-014
 */
describe('tamper-triggered signing block', () => {
  it('TEST-AIRA2-AUDIT-004 blocks signing for a project once an integrity check reports tampering', () => {
    const ledger = new AuditLedger();
    const subsystem = new ElnAuditIntegritySubsystem(ledger);
    const tx = new TxContext();
    ledger.appendAuditEntry(tx, 'create', 'project-4', 'record', 'v1', 'user-a');
    tx.commit();

    expect(subsystem.isSigningBlocked(actor('user-a'), 'project-4')).toBe(false);

    ledger.__testOnlyMutateEntry('project-4', 1, (entry) => ({ ...entry, actorAccountId: 'attacker' }));
    const report = subsystem.runIntegrityCheck(TRUSTED_SCHEDULER_PRINCIPAL, 'project-4');

    expect(report.tampered).toBe(true);
    expect(subsystem.isSigningBlocked(actor('user-a'), 'project-4')).toBe(true);
  });
});

/** @id TEST-AIRA2-AUDIT-005
 * @verifies REQ-ELN-020
 */
describe('alert clearance requires a clean scheduled recheck', () => {
  it('TEST-AIRA2-AUDIT-005 keeps signing blocked after clearance and after a manual check until the next scheduled check runs clean', () => {
    const ledger = new AuditLedger();
    const subsystem = new ElnAuditIntegritySubsystem(ledger);
    const tx = new TxContext();
    ledger.appendAuditEntry(tx, 'create', 'project-5', 'record', 'v1', 'user-a');
    tx.commit();
    ledger.__testOnlyMutateEntry('project-5', 1, (entry) => ({ ...entry, actorAccountId: 'attacker' }));
    subsystem.runIntegrityCheck(TRUSTED_SCHEDULER_PRINCIPAL, 'project-5');
    expect(subsystem.isSigningBlocked(actor('user-a'), 'project-5')).toBe(true);

    subsystem.clearTamperAlert(actor('user-a'), 'project-5');
    expect(subsystem.isSigningBlocked(actor('user-a'), 'project-5')).toBe(true);

    // Underlying tamper is corrected, but a manual check must still not
    // lift the block: only the next *scheduled* check may do so.
    ledger.__testOnlyMutateEntry('project-5', 1, (entry) => ({ ...entry, actorAccountId: 'user-a' }));
    subsystem.runManualIntegrityCheck(actor('user-a'), 'project-5');
    expect(subsystem.isSigningBlocked(actor('user-a'), 'project-5')).toBe(true);

    subsystem.runIntegrityCheck(TRUSTED_SCHEDULER_PRINCIPAL, 'project-5');
    expect(subsystem.isSigningBlocked(actor('user-a'), 'project-5')).toBe(false);
  });
});

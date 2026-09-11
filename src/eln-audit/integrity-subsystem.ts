import { AuditLedger } from './ledger.js';

export interface ElnAuditActorContext {
  accountId: string;
  authorizeProject(projectId: string, action: string): boolean;
}

/** Identity token representing the trusted scheduler service principal.
 * `runIntegrityCheck` accepts only this exact value, never a user-supplied
 * actorContext, so only the internal scheduler can trigger scheduled runs. */
export const TRUSTED_SCHEDULER_PRINCIPAL: unique symbol = Symbol('trusted-scheduler-principal');

export interface IntegrityReport {
  projectId: string;
  trigger: 'scheduled' | 'manual';
  checkedAt: string;
  tampered: boolean;
  tamperedSeqs: number[];
}

export class SigningBlockedError extends Error {
  constructor(projectId: string) {
    super(`Electronic signing is blocked for project ${projectId} pending a clean integrity check`);
  }
}

type ProjectIntegrityState = 'clean' | 'blocked' | 'clearedAwaitingScheduledCheck';

function requireAuthorized(actor: ElnAuditActorContext, projectId: string, action: string): void {
  if (!actor.authorizeProject(projectId, action)) {
    throw new Error(`authorization denied for action: ${action}`);
  }
}

/** @id CODE-AIRA2-AUDIT-003
 * @implements REQ-ELN-013 REQ-ELN-014 REQ-ELN-020
 * @design DES-AIRA2-006
 * Tracks per-project signing-block state driven exclusively by scheduled
 * integrity checks: a manual check can report tampering but only a
 * *scheduled* check may clear `clearedAwaitingScheduledCheck` and lift the
 * signing block.
 */
export class ElnAuditIntegritySubsystem {
  private readonly state = new Map<string, ProjectIntegrityState>();
  private readonly lastReport = new Map<string, IntegrityReport>();

  constructor(private readonly ledger: AuditLedger) {}

  private currentState(projectId: string): ProjectIntegrityState {
    return this.state.get(projectId) ?? 'clean';
  }

  private runCheck(projectId: string, trigger: 'scheduled' | 'manual'): IntegrityReport {
    const tamperedSeqs = this.ledger.detectTamperedEntries(projectId);
    const tampered = tamperedSeqs.length > 0;
    const report: IntegrityReport = {
      projectId,
      trigger,
      checkedAt: new Date().toISOString(),
      tampered,
      tamperedSeqs,
    };
    this.lastReport.set(projectId, report);

    if (tampered) {
      this.state.set(projectId, 'blocked');
    } else if (trigger === 'scheduled') {
      // Only a scheduled clean check may lift an existing block/clearance.
      this.state.set(projectId, 'clean');
    }
    return report;
  }

  runIntegrityCheck(
    schedulerPrincipal: typeof TRUSTED_SCHEDULER_PRINCIPAL,
    projectId: string,
  ): IntegrityReport {
    if (schedulerPrincipal !== TRUSTED_SCHEDULER_PRINCIPAL) {
      throw new Error('runIntegrityCheck may only be invoked by the trusted scheduler principal');
    }
    return this.runCheck(projectId, 'scheduled');
  }

  runManualIntegrityCheck(actor: ElnAuditActorContext, projectId: string): IntegrityReport {
    requireAuthorized(actor, projectId, 'eln.audit-integrity.manage');
    return this.runCheck(projectId, 'manual');
  }

  clearTamperAlert(actor: ElnAuditActorContext, projectId: string): void {
    requireAuthorized(actor, projectId, 'eln.audit-integrity.manage');
    if (this.currentState(projectId) === 'blocked') {
      this.state.set(projectId, 'clearedAwaitingScheduledCheck');
    }
  }

  isSigningBlocked(actor: ElnAuditActorContext, projectId: string): boolean {
    requireAuthorized(actor, projectId, 'eln.audit-integrity.view');
    return this.currentState(projectId) !== 'clean';
  }

  getChainCheckpoint(
    actor: ElnAuditActorContext,
    projectId: string,
  ): { projectId: string; seq: number; hash: string | null; lastReport: IntegrityReport | null } {
    requireAuthorized(actor, projectId, 'eln.audit-integrity.view');
    const entries = this.ledger.listEntries(projectId);
    const last = entries[entries.length - 1];
    return {
      projectId,
      seq: last?.seq ?? 0,
      hash: last?.hash ?? null,
      lastReport: this.lastReport.get(projectId) ?? null,
    };
  }
}

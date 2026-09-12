import type { ProjectAuthorizationService, ActorContext } from '../authz/project-authz.js';
import { AuthorizationDeniedError } from '../authz/project-authz.js';
import { AuditLedger, TxContext } from '../eln-audit/ledger.js';
import { ElnAuditIntegritySubsystem } from '../eln-audit/integrity-subsystem.js';
import type { ElnCoreService } from './eln-core-service.js';
import { ProtocolStore, TRUSTED_APPROVAL_SUBSYSTEM } from './protocol-store.js';
import { canSign, type Account } from '../auth/account.js';
import { SqliteStore } from '../server/store.js';

export interface ApprovalActorContext extends ActorContext {
  isAutomated?: boolean;
  account: Account;
}

export type SignatureMeaning = 'reviewed' | 'approved' | 'witnessed';

export interface SignatureRecord {
  recordVersionId: string;
  signerAccountId: string;
  signerRole: string;
  meaning: SignatureMeaning;
  timestamp: string;
}

export interface ReauthVerifier {
  verifyFreshCredential(actor: ApprovalActorContext): boolean;
}

export class SignatureRejectedError extends Error {}

/** @id CODE-AIRA2-ELN-003
 * @implements REQ-ELN-004 REQ-ELN-006 REQ-ELN-010 REQ-ELN-015 REQ-ELN-016 REQ-ELN-017 REQ-ELN-018 REQ-RUNTIME-002
 * @design DES-AIRA2-007
 * Sole component permitted to move a protocol version to `approved` (via
 * the trusted approval-subsystem token) and to bind electronic signatures
 * to an exact, immutable recordVersionId. REQ-ELN-010 (no in-place
 * modification of signed content) holds structurally: DES-AIRA2-005's
 * `editRecord` only ever creates a new successor version, so there is no
 * API path that mutates a signed version in place.
 */
export class ElnApprovalSignatureService {
  constructor(
    private readonly authz: ProjectAuthorizationService,
    private readonly ledger: AuditLedger,
    private readonly integrity: ElnAuditIntegritySubsystem,
    private readonly protocolStore: ProtocolStore,
    private readonly eln: ElnCoreService,
    private readonly reauth: ReauthVerifier,
    private readonly store: SqliteStore = new SqliteStore({ dbPath: ':memory:' }),
  ) {}

  private requireAuthorized(actor: ActorContext, projectId: string, action: string): void {
    if (!this.authz.authorize(actor, projectId, action)) {
      throw new AuthorizationDeniedError(action);
    }
  }

  approveProtocolVersion(actor: ApprovalActorContext, projectId: string, protocolVersionId: string): void {
    this.requireAuthorized(actor, projectId, 'eln.approve');
    const tx = new TxContext();
    this.protocolStore.markApproved(TRUSTED_APPROVAL_SUBSYSTEM, protocolVersionId);
    this.ledger.appendAuditEntry(tx, 'approve', projectId, 'protocol', protocolVersionId, actor.accountId);
    tx.commit();
  }

  signRecordVersion(
    actor: ApprovalActorContext,
    projectId: string,
    recordId: string,
    recordVersionId: string,
    expectedContentHash: string,
    meaning: SignatureMeaning,
    authorAccountId: string,
  ): SignatureRecord {
    this.requireAuthorized(actor, projectId, 'eln.sign');

    if (actor.isAutomated) {
      throw new SignatureRejectedError('Automated/agent-driven signatures are not permitted');
    }
    if (!canSign(actor.account)) {
      throw new SignatureRejectedError('Signer account is not uniquely bound to one person');
    }
    if (!this.reauth.verifyFreshCredential(actor)) {
      throw new SignatureRejectedError('A fresh re-authentication is required immediately before signing');
    }
    if (
      this.integrity.isSigningBlocked(
        { ...actor, authorizeProject: (pid, action) => this.authz.authorize(actor, pid, action) },
        projectId,
      )
    ) {
      throw new SignatureRejectedError(`Signing is blocked for project ${projectId} pending a clean integrity check`);
    }
    if (meaning === 'approved' && actor.accountId === authorAccountId) {
      throw new SignatureRejectedError('The record/protocol author may not apply the approval signature');
    }

    const history = this.eln.getRecordHistory(actor, projectId, recordId);
    const version = history.versions.find((v) => v.recordVersionId === recordVersionId);
    if (!version) {
      throw new SignatureRejectedError(`Unknown record version: ${recordVersionId}`);
    }
    if (version.contentHash !== expectedContentHash) {
      throw new SignatureRejectedError('The record version content hash has changed since it was last read');
    }

    const signature: SignatureRecord = {
      recordVersionId,
      signerAccountId: actor.accountId,
      signerRole: actor.account.role,
      meaning,
      timestamp: new Date().toISOString(),
    };

    const tx = new TxContext();
    this.store.insertSignature(recordId, signature as unknown as Record<string, unknown>);
    this.ledger.appendAuditEntry(tx, 'approve', projectId, 'record', recordVersionId, actor.accountId);
    tx.commit();

    return signature;
  }

  getSignatureStatus(actor: ActorContext, projectId: string, recordId: string): SignatureRecord[] {
    this.requireAuthorized(actor, projectId, 'eln.view');
    return this.store.listSignatures<SignatureRecord>(recordId);
  }

  voidRecord(actor: ActorContext, projectId: string, recordId: string): void {
    this.requireAuthorized(actor, projectId, 'eln.void');
    const tx = new TxContext();
    this.eln.markVoided(recordId);
    this.ledger.appendAuditEntry(tx, 'void', projectId, 'record', recordId, actor.accountId);
    tx.commit();
  }
}

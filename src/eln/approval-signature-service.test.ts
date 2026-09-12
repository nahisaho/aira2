import { describe, expect, it } from 'vitest';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';
import { AuditLedger } from '../eln-audit/ledger.js';
import { ElnAuditIntegritySubsystem } from '../eln-audit/integrity-subsystem.js';
import { ProtocolStore } from './protocol-store.js';
import { ElnCoreService } from './eln-core-service.js';
import { ElnApprovalSignatureService, SignatureRejectedError, type ReauthVerifier } from './approval-signature-service.js';
import { createAccount } from '../auth/account.js';
import { SqliteStore } from '../server/store.js';

const FIELDS = {
  objective: 'Measure enzyme kinetics',
  method: 'Spectrophotometric assay',
  rawData: 'raw.csv',
  results: 'Vmax = 12.3',
  conclusion: 'Consistent with prior runs',
};

function setup(reauthApproves = true) {
  const authz = new ProjectAuthorizationService(new AuditLog(), {
    terminateSessionsAndConnections: () => undefined,
  });
  authz.createProject('author-1', 'project-1');
  authz.grantShare({ accountId: 'author-1' }, 'project-1', 'approver-1', 'editor');
  const ledger = new AuditLedger();
  const integrity = new ElnAuditIntegritySubsystem(ledger);
  const protocolStore = new ProtocolStore();
  const eln = new ElnCoreService(authz, ledger, protocolStore);
  const reauth: ReauthVerifier = { verifyFreshCredential: () => reauthApproves };
  const approval = new ElnApprovalSignatureService(authz, ledger, integrity, protocolStore, eln, reauth);
  return { authz, ledger, integrity, protocolStore, eln, approval };
}

function humanAccount(id: string) {
  return createAccount({ displayName: id, externalIdentity: id, assignedPersonId: id });
}

/** @id TEST-AIRA2-APPROVAL-001
 * @verifies REQ-ELN-004
 */
describe('protocol approval workflow', () => {
  it('TEST-AIRA2-APPROVAL-001 rejects linking a draft protocol and succeeds only after an authorized approval action', () => {
    const { protocolStore, eln, approval } = setup();
    const draft = protocolStore.createProtocol('project-1', 'SOP draft');
    const author = { accountId: 'author-1', account: humanAccount('author-1') };

    expect(() => eln.createRecord(author, 'project-1', FIELDS, draft.protocolVersionId)).toThrow();

    approval.approveProtocolVersion(author, 'project-1', draft.protocolVersionId);
    const record = eln.createRecord(author, 'project-1', FIELDS, draft.protocolVersionId);
    expect(record.protocolVersionId).toBe(draft.protocolVersionId);
  });
});

/** @id TEST-AIRA2-APPROVAL-002
 * @verifies REQ-ELN-006
 */
describe('electronic signatures bound to a version', () => {
  it('TEST-AIRA2-APPROVAL-002 binds signer, role, timestamp, and meaning to the exact signed version, unaffected by later edits', () => {
    const { eln, approval } = setup();
    const author = { accountId: 'author-1', account: humanAccount('author-1') };
    const approver = { accountId: 'approver-1', account: humanAccount('approver-1') };
    const record = eln.createRecord(author, 'project-1', FIELDS);

    const signature = approval.signRecordVersion(
      approver,
      'project-1',
      record.recordId,
      record.recordVersionId,
      record.contentHash,
      'reviewed',
      'author-1',
    );
    expect(signature.recordVersionId).toBe(record.recordVersionId);
    expect(signature.signerAccountId).toBe('approver-1');
    expect(signature.meaning).toBe('reviewed');
    expect(typeof signature.timestamp).toBe('string');

    eln.editRecord(author, 'project-1', record.recordId, { ...FIELDS, conclusion: 'Updated' });

    const statuses = approval.getSignatureStatus(author, 'project-1', record.recordId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.recordVersionId).toBe(record.recordVersionId);
  });
});

/** @id TEST-AIRA2-APPROVAL-003
 * @verifies REQ-ELN-016
 */
describe('signing re-authentication', () => {
  it('TEST-AIRA2-APPROVAL-003 rejects a signature without a fresh re-authentication and accepts it once re-authenticated', () => {
    const { eln, approval } = setup(false);
    const author = { accountId: 'author-1', account: humanAccount('author-1') };
    const approver = { accountId: 'approver-1', account: humanAccount('approver-1') };
    const record = eln.createRecord(author, 'project-1', FIELDS);

    expect(() =>
      approval.signRecordVersion(
        approver,
        'project-1',
        record.recordId,
        record.recordVersionId,
        record.contentHash,
        'reviewed',
        'author-1',
      ),
    ).toThrow(SignatureRejectedError);

    const { eln: eln2, approval: approvalOk } = setup(true);
    const record2 = eln2.createRecord(author, 'project-1', FIELDS);
    const signature = approvalOk.signRecordVersion(
      approver,
      'project-1',
      record2.recordId,
      record2.recordVersionId,
      record2.contentHash,
      'reviewed',
      'author-1',
    );
    expect(signature.signerAccountId).toBe('approver-1');
  });
});

/** @id TEST-AIRA2-APPROVAL-004
 * @verifies REQ-ELN-017
 */
describe('approval separation of duties', () => {
  it('TEST-AIRA2-APPROVAL-004 rejects an approval signature from the record author and accepts it from a different authorized user', () => {
    const { eln, approval } = setup();
    const author = { accountId: 'author-1', account: humanAccount('author-1') };
    const approver = { accountId: 'approver-1', account: humanAccount('approver-1') };
    const record = eln.createRecord(author, 'project-1', FIELDS);

    expect(() =>
      approval.signRecordVersion(
        author,
        'project-1',
        record.recordId,
        record.recordVersionId,
        record.contentHash,
        'approved',
        'author-1',
      ),
    ).toThrow(SignatureRejectedError);

    const signature = approval.signRecordVersion(
      approver,
      'project-1',
      record.recordId,
      record.recordVersionId,
      record.contentHash,
      'approved',
      'author-1',
    );
    expect(signature.meaning).toBe('approved');
  });
});

/** @id TEST-AIRA2-APPROVAL-005
 * @verifies REQ-ELN-018
 */
describe('no automated signature impersonation', () => {
  it('TEST-AIRA2-APPROVAL-005 rejects a signature attempt from an automated agent/LLM-driven actor', () => {
    const { eln, approval } = setup();
    const author = { accountId: 'author-1', account: humanAccount('author-1') };
    const automatedActor = { accountId: 'approver-1', account: humanAccount('approver-1'), isAutomated: true };
    const record = eln.createRecord(author, 'project-1', FIELDS);

    expect(() =>
      approval.signRecordVersion(
        automatedActor,
        'project-1',
        record.recordId,
        record.recordVersionId,
        record.contentHash,
        'reviewed',
        'author-1',
      ),
    ).toThrow(SignatureRejectedError);
  });
});

/** @id TEST-AIRA2-APPROVAL-006
 * @verifies REQ-ELN-010
 */
describe('access control on signed records', () => {
  it('TEST-AIRA2-APPROVAL-006 has no in-place edit path for a signed version, only a new successor version that can be separately signed', () => {
    const { eln, approval } = setup();
    const author = { accountId: 'author-1', account: humanAccount('author-1') };
    const approver = { accountId: 'approver-1', account: humanAccount('approver-1') };
    const record = eln.createRecord(author, 'project-1', FIELDS);
    approval.signRecordVersion(
      approver,
      'project-1',
      record.recordId,
      record.recordVersionId,
      record.contentHash,
      'reviewed',
      'author-1',
    );

    const nextVersion = eln.editRecord(author, 'project-1', record.recordId, {
      ...FIELDS,
      conclusion: 'New successor content',
    });
    expect(nextVersion.recordVersionId).not.toBe(record.recordVersionId);
    expect(nextVersion.predecessorVersionId).toBe(record.recordVersionId);

    const newSignature = approval.signRecordVersion(
      approver,
      'project-1',
      record.recordId,
      nextVersion.recordVersionId,
      nextVersion.contentHash,
      'reviewed',
      'author-1',
    );
    expect(newSignature.recordVersionId).toBe(nextVersion.recordVersionId);

    const history = eln.getRecordHistory(author, 'project-1', record.recordId);
    expect(history.versions.find((v) => v.recordVersionId === record.recordVersionId)?.conclusion).toBe(
      FIELDS.conclusion,
    );
  });
});

/** @id TEST-AIRA2-APPROVAL-007
 * @verifies REQ-ELN-015
 */
describe('non-destructive void of signed records', () => {
  it('TEST-AIRA2-APPROVAL-007 excludes a voided signed record from active search while retaining its full content, versions, signatures, and audit history', () => {
    const { eln, approval } = setup();
    const author = { accountId: 'author-1', account: humanAccount('author-1') };
    const approver = { accountId: 'approver-1', account: humanAccount('approver-1') };
    const record = eln.createRecord(author, 'project-1', FIELDS);
    approval.signRecordVersion(
      approver,
      'project-1',
      record.recordId,
      record.recordVersionId,
      record.contentHash,
      'reviewed',
      'author-1',
    );

    expect(eln.search(author, 'project-1', { projectId: 'project-1' })).toHaveLength(1);

    approval.voidRecord(author, 'project-1', record.recordId);

    expect(eln.search(author, 'project-1', { projectId: 'project-1' })).toHaveLength(0);

    const history = eln.getRecordHistory(author, 'project-1', record.recordId);
    expect(history.voided).toBe(true);
    expect(history.versions).toHaveLength(1);
    const signatures = approval.getSignatureStatus(author, 'project-1', record.recordId);
    expect(signatures).toHaveLength(1);
  });
});

/** @id TEST-AIRA2-APPROVAL-008
 * @verifies REQ-MULTIUSER-011
 */
describe('project-boundary enforcement for approval actions', () => {
  it('TEST-AIRA2-APPROVAL-008 rejects cross-project approve, sign, and void attempts with the same not-found style errors used for unknown ids', () => {
    const store = new SqliteStore({ dbPath: ':memory:' });
    const authz = new ProjectAuthorizationService(
      new AuditLog(store),
      { terminateSessionsAndConnections: () => undefined },
      store,
    );
    authz.createProject('owner-1', 'project-1');
    authz.createProject('owner-2', 'project-2');
    authz.grantShare({ accountId: 'owner-1' }, 'project-1', 'approver-1', 'editor');
    const ledger = new AuditLedger(store);
    const integrity = new ElnAuditIntegritySubsystem(ledger, store);
    const protocolStore = new ProtocolStore(store);
    const eln = new ElnCoreService(authz, ledger, protocolStore, store);
    const reauth: ReauthVerifier = { verifyFreshCredential: () => true };
    const approval = new ElnApprovalSignatureService(authz, ledger, integrity, protocolStore, eln, reauth, store);
    const owner = { accountId: 'owner-1', account: humanAccount('owner-1') };
    const outsider = { accountId: 'owner-2', account: humanAccount('owner-2') };
    const protocol = protocolStore.createProtocol('project-1', 'SOP draft');
    approval.approveProtocolVersion(owner, 'project-1', protocol.protocolVersionId);
    const record = eln.createRecord(owner, 'project-1', FIELDS, protocol.protocolVersionId);

    expect(() =>
      approval.approveProtocolVersion(outsider, 'project-2', protocol.protocolVersionId),
    ).toThrowError(`Unknown protocol version: ${protocol.protocolVersionId}`);
    expect(() =>
      approval.voidRecord(outsider, 'project-2', record.recordId),
    ).toThrowError(`Unknown experiment record: ${record.recordId}`);
    expect(() =>
      approval.signRecordVersion(
        outsider,
        'project-2',
        record.recordId,
        record.recordVersionId,
        record.contentHash,
        'reviewed',
        'owner-1',
      ),
    ).toThrowError(`Unknown experiment record: ${record.recordId}`);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';
import { AuditLedger } from '../eln-audit/ledger.js';
import { ProtocolStore, TRUSTED_APPROVAL_SUBSYSTEM } from './protocol-store.js';
import { ElnCoreService } from './eln-core-service.js';
import { ElnAuditIntegritySubsystem } from '../eln-audit/integrity-subsystem.js';
import { ElnApprovalSignatureService, type ReauthVerifier } from './approval-signature-service.js';
import { createAccount } from '../auth/account.js';
import { SqliteStore } from '../server/store.js';

function setup() {
  const authz = new ProjectAuthorizationService(new AuditLog(), {
    terminateSessionsAndConnections: () => undefined,
  });
  authz.createProject('owner-1', 'project-1');
  const ledger = new AuditLedger();
  const protocolStore = new ProtocolStore();
  const service = new ElnCoreService(authz, ledger, protocolStore);
  return { authz, ledger, protocolStore, service };
}

function persistenceSetup(dbPath: string) {
  const store = new SqliteStore({ dbPath });
  const authz = new ProjectAuthorizationService(
    new AuditLog(store),
    { terminateSessionsAndConnections: () => undefined },
    store,
  );
  authz.createProject('owner-1', 'project-1');
  authz.grantShare({ accountId: 'owner-1' }, 'project-1', 'signer-1', 'editor');
  const ledger = new AuditLedger(store);
  const protocolStore = new ProtocolStore(store);
  const service = new ElnCoreService(authz, ledger, protocolStore, store);
  const integrity = new ElnAuditIntegritySubsystem(ledger, store);
  const reauth: ReauthVerifier = { verifyFreshCredential: () => true };
  const approval = new ElnApprovalSignatureService(authz, ledger, integrity, protocolStore, service, reauth, store);
  return { store, authz, ledger, protocolStore, service, approval };
}

const FIELDS = {
  objective: 'Measure enzyme kinetics',
  method: 'Spectrophotometric assay',
  rawData: 'raw.csv',
  results: 'Vmax = 12.3',
  conclusion: 'Consistent with prior runs',
};

/** @id TEST-AIRA2-ELN-001
 * @verifies REQ-ELN-001
 */
describe('structured experiment records', () => {
  it('TEST-AIRA2-ELN-001 creates an experiment record with structured fields, gated by project authorization', () => {
    const { service } = setup();
    const record = service.createRecord({ accountId: 'owner-1' }, 'project-1', FIELDS);
    expect(record.versionNumber).toBe(1);
    expect(record.objective).toBe(FIELDS.objective);
    expect(record.method).toBe(FIELDS.method);
    expect(record.rawData).toBe(FIELDS.rawData);
    expect(record.results).toBe(FIELDS.results);
    expect(record.conclusion).toBe(FIELDS.conclusion);
    expect(record.predecessorVersionId).toBeNull();

    expect(() => service.createRecord({ accountId: 'stranger' }, 'project-1', FIELDS)).toThrow();
  });
});

/** @id TEST-AIRA2-ELN-009
 * @verifies REQ-MULTIUSER-011
 */
describe('project-boundary enforcement for records', () => {
  it('TEST-AIRA2-ELN-009 rejects cross-project reads and edits with the same not-found outcome used for an unknown record id', () => {
    const authz = new ProjectAuthorizationService(new AuditLog(), {
      terminateSessionsAndConnections: () => undefined,
    });
    authz.createProject('owner-1', 'project-1');
    authz.createProject('owner-2', 'project-2');
    const ledger = new AuditLedger();
    const protocolStore = new ProtocolStore();
    const service = new ElnCoreService(authz, ledger, protocolStore);
    const record = service.createRecord({ accountId: 'owner-1' }, 'project-1', FIELDS);
    const actor = { accountId: 'owner-2' };

    expect(() => service.getRecordHistory(actor, 'project-2', record.recordId)).toThrowError(
      `Unknown experiment record: ${record.recordId}`,
    );
    expect(() => service.getProvenance(actor, 'project-2', record.recordId)).toThrowError(
      `Unknown experiment record: ${record.recordId}`,
    );
    expect(() => service.editRecord(actor, 'project-2', record.recordId, FIELDS)).toThrowError(
      `Unknown experiment record: ${record.recordId}`,
    );
    expect(() => service.getRecordHistory(actor, 'project-2', 'missing-record')).toThrowError(
      'Unknown experiment record: missing-record',
    );
  });
});

/** @id TEST-AIRA2-AUDIT-007
 * @verifies REQ-ELN-005
 */
describe('atomic ELN edit and audit append', () => {
  it('TEST-AIRA2-AUDIT-007 rolls back a record edit when the audit append fails', () => {
    const store = new SqliteStore({ dbPath: ':memory:' });
    const authz = new ProjectAuthorizationService(
      new AuditLog(store),
      { terminateSessionsAndConnections: () => undefined },
      store,
    );
    authz.createProject('owner-1', 'project-1');
    const ledger = new AuditLedger(store);
    const protocolStore = new ProtocolStore(store);
    const service = new ElnCoreService(authz, ledger, protocolStore, store);
    const record = service.createRecord({ accountId: 'owner-1' }, 'project-1', FIELDS);

    vi.spyOn(ledger, 'appendAuditEntry').mockImplementation(() => {
      throw new Error('forced audit failure');
    });

    expect(() =>
      service.editRecord({ accountId: 'owner-1' }, 'project-1', record.recordId, {
        ...FIELDS,
        conclusion: 'should roll back',
      }),
    ).toThrowError('forced audit failure');

    const history = service.getRecordHistory({ accountId: 'owner-1' }, 'project-1', record.recordId);
    expect(history.versions).toHaveLength(1);
    expect(history.versions[0]?.conclusion).toBe(FIELDS.conclusion);
  });
});

/** @id TEST-AIRA2-ELN-010
 * @verifies REQ-MULTIUSER-011
 */
describe('project-boundary enforcement for protocol version linkage', () => {
  it('TEST-AIRA2-ELN-010 rejects linking an approved protocol version that belongs to a different project', () => {
    const authz = new ProjectAuthorizationService(new AuditLog(), {
      terminateSessionsAndConnections: () => undefined,
    });
    authz.createProject('owner-1', 'project-1');
    authz.createProject('owner-2', 'project-2');
    const ledger = new AuditLedger();
    const protocolStore = new ProtocolStore();
    const service = new ElnCoreService(authz, ledger, protocolStore);

    const foreignVersion = protocolStore.createProtocol('project-2', 'Project 2 SOP');
    protocolStore.markApproved(TRUSTED_APPROVAL_SUBSYSTEM, foreignVersion.protocolVersionId);

    expect(() =>
      service.createRecord({ accountId: 'owner-1' }, 'project-1', FIELDS, foreignVersion.protocolVersionId),
    ).toThrowError(`Protocol version must be approved to link: ${foreignVersion.protocolVersionId}`);
  });
});

/** @id TEST-AIRA2-AUDIT-008
 * @verifies REQ-ELN-005
 */
describe('atomic ELN inventory/provenance edits and audit append', () => {
  it('TEST-AIRA2-AUDIT-008 rolls back an inventory link when the audit append fails', () => {
    const store = new SqliteStore({ dbPath: ':memory:' });
    const authz = new ProjectAuthorizationService(
      new AuditLog(store),
      { terminateSessionsAndConnections: () => undefined },
      store,
    );
    authz.createProject('owner-1', 'project-1');
    const ledger = new AuditLedger(store);
    const protocolStore = new ProtocolStore(store);
    const service = new ElnCoreService(authz, ledger, protocolStore, store);
    const record = service.createRecord({ accountId: 'owner-1' }, 'project-1', FIELDS);

    vi.spyOn(ledger, 'appendAuditEntry').mockImplementation(() => {
      throw new Error('forced audit failure');
    });

    expect(() =>
      service.linkInventory({ accountId: 'owner-1' }, 'project-1', record.recordId, {
        identifier: 'reagent-1',
        lotNumber: 'lot-1',
      }),
    ).toThrowError('forced audit failure');

    const inventory = service.getInventoryContext({ accountId: 'owner-1' }, 'project-1', record.recordId);
    expect(inventory).toHaveLength(0);
  });
});

/** @id TEST-AIRA2-APPROVAL-009
 * @verifies REQ-MULTIUSER-011
 */
describe('project-boundary enforcement for signature status', () => {
  it('TEST-AIRA2-APPROVAL-009 rejects reading signature status for a record in a different project', () => {
    const { store, authz, ledger, protocolStore, service, approval } = persistenceSetup(':memory:');
    authz.createProject('owner-2', 'project-2');
    const record = service.createRecord({ accountId: 'owner-1' }, 'project-1', FIELDS);
    const actor = { accountId: 'owner-2' };

    expect(() => approval.getSignatureStatus(actor, 'project-2', record.recordId)).toThrowError(
      `Unknown experiment record: ${record.recordId}`,
    );
    void store;
    void ledger;
    void protocolStore;
  });
});

/** @id TEST-AIRA2-ELN-002
 * @verifies REQ-ELN-002
 */
describe('experiment record versioning', () => {
  it('TEST-AIRA2-ELN-002 retains the prior version and makes the full history retrievable after an edit', () => {
    const { service } = setup();
    const actor = { accountId: 'owner-1' };
    const v1 = service.createRecord(actor, 'project-1', FIELDS);
    const v2 = service.editRecord(actor, 'project-1', v1.recordId, {
      ...FIELDS,
      conclusion: 'Revised conclusion',
    });

    expect(v2.versionNumber).toBe(2);
    expect(v2.predecessorVersionId).toBe(v1.recordVersionId);
    expect(v2.recordVersionId).not.toBe(v1.recordVersionId);

    const history = service.getRecordHistory(actor, 'project-1', v1.recordId);
    expect(history.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(history.versions[0]?.conclusion).toBe(FIELDS.conclusion);
    expect(history.versions[1]?.conclusion).toBe('Revised conclusion');
  });
});

/** @id TEST-AIRA2-ELN-004
 * @verifies REQ-ELN-019
 */
describe('immutable protocol version linkage', () => {
  it('TEST-AIRA2-ELN-004 accepts only an approved protocol version link and keeps it unchanged after later revision', () => {
    const { service, protocolStore } = setup();
    const actor = { accountId: 'owner-1' };
    const draftVersion = protocolStore.createProtocol('project-1', 'Draft SOP');

    expect(() => service.createRecord(actor, 'project-1', FIELDS, draftVersion.protocolVersionId)).toThrow();

    protocolStore.markApproved(TRUSTED_APPROVAL_SUBSYSTEM, draftVersion.protocolVersionId);
    const record = service.createRecord(actor, 'project-1', FIELDS, draftVersion.protocolVersionId);
    expect(record.protocolVersionId).toBe(draftVersion.protocolVersionId);

    const nextProtocolVersion = protocolStore.createProtocolVersion(draftVersion.protocolId, 'Revised SOP');
    protocolStore.markApproved(TRUSTED_APPROVAL_SUBSYSTEM, nextProtocolVersion.protocolVersionId);

    const edited = service.editRecord(actor, 'project-1', record.recordId, FIELDS);
    expect(edited.protocolVersionId).toBe(draftVersion.protocolVersionId);
  });
});

/** @id TEST-AIRA2-ELN-005
 * @verifies REQ-ELN-007 REQ-ELN-012
 */
describe('sample/reagent/inventory linkage and context display', () => {
  it('TEST-AIRA2-ELN-005 persists the linked identifier and lot number and displays it alongside the record', () => {
    const { service } = setup();
    const actor = { accountId: 'owner-1' };
    const record = service.createRecord(actor, 'project-1', FIELDS);

    service.linkInventory(actor, 'project-1', record.recordId, {
      identifier: 'REAGENT-42',
      lotNumber: 'LOT-2024-07',
    });

    const context = service.getInventoryContext(actor, 'project-1', record.recordId);
    expect(context).toEqual([{ identifier: 'REAGENT-42', lotNumber: 'LOT-2024-07' }]);

    const history = service.getRecordHistory(actor, 'project-1', record.recordId);
    expect(history.inventoryLinks).toEqual([{ identifier: 'REAGENT-42', lotNumber: 'LOT-2024-07' }]);
  });
});

/** @id TEST-AIRA2-ELN-006
 * @verifies REQ-ELN-008
 */
describe('ELN search and reporting', () => {
  it('TEST-AIRA2-ELN-006 finds records by project, protocol, sample identifier, and free text, and exports the results as a report', () => {
    const { service, protocolStore } = setup();
    const actor = { accountId: 'owner-1' };
    const protocolVersion = protocolStore.createProtocol('project-1', 'SOP');
    protocolStore.markApproved(TRUSTED_APPROVAL_SUBSYSTEM, protocolVersion.protocolVersionId);

    const matchRecord = service.createRecord(actor, 'project-1', FIELDS, protocolVersion.protocolVersionId);
    service.linkInventory(actor, 'project-1', matchRecord.recordId, {
      identifier: 'SAMPLE-9',
      lotNumber: 'LOT-1',
    });
    service.createRecord(actor, 'project-1', { ...FIELDS, objective: 'Unrelated objective' });

    const bySample = service.search(actor, 'project-1', { projectId: 'project-1', sampleIdentifier: 'SAMPLE-9' });
    expect(bySample.map((r) => r.recordId)).toEqual([matchRecord.recordId]);

    const byFreeText = service.search(actor, 'project-1', { projectId: 'project-1', freeText: 'enzyme kinetics' });
    expect(byFreeText.map((r) => r.recordId)).toEqual([matchRecord.recordId]);

    const report = service.exportSearchResults(actor, 'project-1', {
      projectId: 'project-1',
      protocolVersionId: protocolVersion.protocolVersionId,
    });
    expect(report.matches.map((r) => r.recordId)).toEqual([matchRecord.recordId]);
  });
});

/** @id TEST-AIRA2-ELN-007
 * @verifies REQ-ELN-009
 */
describe('computational provenance integration', () => {
  it('TEST-AIRA2-ELN-007 links a record to its notebook execution trace, cell citations, and reproducibility gate results', () => {
    const { service } = setup();
    const actor = { accountId: 'owner-1' };
    const record = service.createRecord(actor, 'project-1', FIELDS);

    service.linkProvenance(actor, 'project-1', record.recordId, {
      notebookExecutionTraceRef: 'notebook-exec-77',
      citations: ['[cell:3]', '[cell:5]'],
      reproducibilityGateResults: 'pass',
    });

    const provenance = service.getProvenance(actor, 'project-1', record.recordId);
    expect(provenance).toEqual({
      notebookExecutionTraceRef: 'notebook-exec-77',
      citations: ['[cell:3]', '[cell:5]'],
      reproducibilityGateResults: 'pass',
    });
  });

  /** @id TEST-AIRA2-ELN-008
   * @verifies REQ-RUNTIME-002
   */
  describe('ELN persistence across restarts', () => {
    it('TEST-AIRA2-ELN-008 preserves protocol versions, record history, signatures, and audit entries after reopening the SQLite store', () => {
      const dbPath = resolve('data/test-artifacts/eln-persistence.sqlite');
      mkdirSync(dirname(dbPath), { recursive: true });
      rmSync(dbPath, { force: true });

      {
        const { store, protocolStore, service, approval, ledger } = persistenceSetup(dbPath);
        const owner = { accountId: 'owner-1', account: createAccount({ displayName: 'owner', externalIdentity: 'owner-1', assignedPersonId: 'owner-1' }) };
        const signer = { accountId: 'signer-1', account: createAccount({ displayName: 'signer', externalIdentity: 'signer-1', assignedPersonId: 'signer-1' }) };
        const protocol = protocolStore.createProtocol('project-1', 'Approved SOP');
        approval.approveProtocolVersion(owner, 'project-1', protocol.protocolVersionId);
        const record = service.createRecord(owner, 'project-1', FIELDS, protocol.protocolVersionId);
        const edited = service.editRecord(owner, 'project-1', record.recordId, { ...FIELDS, conclusion: 'after restart' });
        approval.signRecordVersion(signer, 'project-1', record.recordId, edited.recordVersionId, edited.contentHash, 'reviewed', 'owner-1');
        expect(ledger.listEntries('project-1').length).toBeGreaterThan(0);
        store.close();
      }

      {
        const { store, protocolStore, service, approval, ledger } = persistenceSetup(dbPath);
        const owner = { accountId: 'owner-1', account: createAccount({ displayName: 'owner', externalIdentity: 'owner-1', assignedPersonId: 'owner-1' }) };
        const protocolVersions = protocolStore.getAllVersions('project-1');
        expect(protocolVersions.length).toBe(1);
        expect(protocolVersions[0]?.status).toBe('approved');

        const records = service.listRecordIds('project-1');
        expect(records.length).toBe(1);
        const history = service.getRecordHistory(owner, 'project-1', records[0]!);
        expect(history.versions).toHaveLength(2);
        expect(history.versions[1]?.conclusion).toBe('after restart');
        expect(approval.getSignatureStatus(owner, 'project-1', records[0]!)).toHaveLength(1);
        expect(ledger.listEntries('project-1').length).toBeGreaterThanOrEqual(3);
        store.close();
      }

      rmSync(dbPath, { force: true });
    });
  });
});

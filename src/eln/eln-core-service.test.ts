import { describe, expect, it } from 'vitest';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';
import { AuditLedger } from '../eln-audit/ledger.js';
import { ProtocolStore, TRUSTED_APPROVAL_SUBSYSTEM } from './protocol-store.js';
import { ElnCoreService } from './eln-core-service.js';

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
});

import { describe, expect, it } from 'vitest';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';
import { AuditLedger } from '../eln-audit/ledger.js';
import { ProtocolStore, TRUSTED_APPROVAL_SUBSYSTEM } from '../eln/protocol-store.js';
import { ElnCoreService } from '../eln/eln-core-service.js';
import { ElnUiController } from './eln-ui.js';
import { DesignSystemRegistry } from './design-system.js';

function setup() {
  const authz = new ProjectAuthorizationService(new AuditLog(), {
    terminateSessionsAndConnections: () => undefined,
  });
  authz.createProject('owner-1', 'project-1');
  const ledger = new AuditLedger();
  const protocolStore = new ProtocolStore();
  const elnCoreService = new ElnCoreService(authz, ledger, protocolStore);
  const registry = new DesignSystemRegistry();
  const controller = new ElnUiController(authz, elnCoreService, ledger, registry);
  return { authz, ledger, protocolStore, elnCoreService, controller };
}

const FIELDS = {
  objective: 'Measure enzyme kinetics',
  method: 'Spectrophotometric assay',
  rawData: 'raw.csv',
  results: 'Vmax = 12.3',
  conclusion: 'Consistent with prior runs',
};

const actor = { accountId: 'owner-1' };

/** @id TEST-AIRA2-GUI-003
 * @verifies REQ-GUI-003
 */
describe('ELN UI', () => {
  it('TEST-AIRA2-GUI-003 renders experiment records, linked protocol, linked inventory identifiers, and audit history for the active project', () => {
    const { controller, protocolStore, elnCoreService } = setup();
    const protocol = protocolStore.createProtocol('project-1', 'SOP: enzyme assay procedure');
    protocolStore.markApproved(TRUSTED_APPROVAL_SUBSYSTEM, protocol.protocolVersionId);

    const record = elnCoreService.createRecord(actor, 'project-1', FIELDS, protocol.protocolVersionId);
    elnCoreService.linkInventory(actor, 'project-1', record.recordId, {
      identifier: 'REAGENT-42',
      lotNumber: 'LOT-2024-01',
    });

    const view = controller.openProjectTab(actor, 'project-1');

    expect(view.records).toHaveLength(1);
    const [recordView] = view.records;
    expect(recordView!.protocolVersionId).toBe(protocol.protocolVersionId);
    expect(recordView!.inventoryLinks).toEqual([{ identifier: 'REAGENT-42', lotNumber: 'LOT-2024-01' }]);
    expect(view.auditHistory.length).toBeGreaterThan(0);
    expect(view.auditHistory.some((entry) => entry.action === 'create')).toBe(true);
  });
});

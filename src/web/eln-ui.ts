import type { ProjectAuthorizationService, ActorContext } from '../authz/project-authz.js';
import { AuthorizationDeniedError } from '../authz/project-authz.js';
import { ElnCoreService, type ExperimentRecordVersion, type InventoryLink } from '../eln/eln-core-service.js';
import { AuditLedger, type AuditEntry } from '../eln-audit/ledger.js';
import { DesignSystemRegistry } from './design-system.js';

export interface ElnRecordView {
  recordId: string;
  latest: ExperimentRecordVersion;
  protocolVersionId: string | null;
  inventoryLinks: InventoryLink[];
}

export interface ElnProjectView {
  projectId: string;
  records: ElnRecordView[];
  auditHistory: readonly AuditEntry[];
}

/** @id CODE-AIRA2-GUI-004
 * @implements REQ-GUI-003
 * @design DES-AIRA2-010
 * View-model for the ELN tab: for the active project, renders experiment
 * records together with their linked protocol/SOP version, linked
 * sample/inventory identifiers, and the project's audit trail history,
 * gated on the viewing actor's project role per DES-AIRA2-002.
 */
export class ElnUiController {
  constructor(
    private readonly authz: ProjectAuthorizationService,
    private readonly elnCoreService: ElnCoreService,
    private readonly ledger: AuditLedger,
    registry: DesignSystemRegistry = new DesignSystemRegistry(),
  ) {
    registry.register('eln');
  }

  openProjectTab(actor: ActorContext, projectId: string): ElnProjectView {
    if (!this.authz.authorize(actor, projectId, 'eln.view')) {
      throw new AuthorizationDeniedError('eln.view');
    }
    const matches = this.elnCoreService.search(actor, projectId, { projectId });
    const latestByRecord = new Map<string, ExperimentRecordVersion>();
    for (const version of matches) {
      const existing = latestByRecord.get(version.recordId);
      if (!existing || version.versionNumber > existing.versionNumber) {
        latestByRecord.set(version.recordId, version);
      }
    }
    const records: ElnRecordView[] = Array.from(latestByRecord.values()).map((latest) => ({
      recordId: latest.recordId,
      latest,
      protocolVersionId: latest.protocolVersionId,
      inventoryLinks: this.elnCoreService.getInventoryContext(actor, projectId, latest.recordId),
    }));

    const canViewAuditHistory = this.authz.authorize(actor, projectId, 'eln.audit-history.view');
    return {
      projectId,
      records,
      auditHistory: canViewAuditHistory ? this.ledger.listEntries(projectId) : [],
    };
  }
}

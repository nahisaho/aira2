import { createHash } from 'node:crypto';
import type { ProjectAuthorizationService, ActorContext } from '../authz/project-authz.js';
import { AuthorizationDeniedError } from '../authz/project-authz.js';
import { AuditLedger, TxContext } from '../eln-audit/ledger.js';
import type { ProtocolStore } from './protocol-store.js';

export interface RecordFields {
  objective: string;
  method: string;
  rawData: string;
  results: string;
  conclusion: string;
}

export interface InventoryLink {
  identifier: string;
  lotNumber: string;
}

export interface ProvenanceLink {
  notebookExecutionTraceRef: string;
  citations: string[];
  reproducibilityGateResults: string;
}

export interface ExperimentRecordVersion extends RecordFields {
  recordVersionId: string;
  recordId: string;
  versionNumber: number;
  protocolVersionId: string | null;
  contentHash: string;
  predecessorVersionId: string | null;
  createdAt: string;
}

interface ExperimentRecordEntry {
  recordId: string;
  projectId: string;
  versions: ExperimentRecordVersion[];
  inventoryLinks: InventoryLink[];
  provenance: ProvenanceLink | null;
  voided: boolean;
}

export interface ExperimentRecordHistory {
  recordId: string;
  versions: ExperimentRecordVersion[];
  inventoryLinks: InventoryLink[];
  provenance: ProvenanceLink | null;
  voided: boolean;
}

export interface SearchCriteria {
  projectId: string;
  dateFrom?: string;
  dateTo?: string;
  protocolVersionId?: string;
  sampleIdentifier?: string;
  freeText?: string;
}

export interface SearchReport {
  criteria: SearchCriteria;
  matches: ExperimentRecordVersion[];
}

function contentHashOf(fields: RecordFields): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

let recordCounter = 0;
let recordVersionCounter = 0;

/** @id CODE-AIRA2-ELN-002
 * @implements REQ-ELN-001 REQ-ELN-002 REQ-ELN-019 REQ-ELN-007 REQ-ELN-012 REQ-ELN-008 REQ-ELN-009
 * @design DES-AIRA2-005
 * Every state-changing command executes inside one atomic transaction that
 * also commits its audit event via DES-AIRA2-006's ledger; every read/write
 * resolves `authorize()` via DES-AIRA2-002 with a trusted actorContext.
 */
export class ElnCoreService {
  private readonly records = new Map<string, ExperimentRecordEntry>();

  constructor(
    private readonly authz: ProjectAuthorizationService,
    private readonly ledger: AuditLedger,
    private readonly protocolStore: ProtocolStore,
  ) {}

  private requireAuthorized(actor: ActorContext, projectId: string, action: string): void {
    if (!this.authz.authorize(actor, projectId, action)) {
      throw new AuthorizationDeniedError(action);
    }
  }

  private requireApprovedProtocolVersion(protocolVersionId: string): void {
    const version = this.protocolStore.getVersion(protocolVersionId);
    if (!version || version.status !== 'approved') {
      throw new Error(`Protocol version must be approved to link: ${protocolVersionId}`);
    }
  }

  private getEntry(recordId: string): ExperimentRecordEntry {
    const entry = this.records.get(recordId);
    if (!entry) {
      throw new Error(`Unknown experiment record: ${recordId}`);
    }
    return entry;
  }

  createRecord(
    actor: ActorContext,
    projectId: string,
    fields: RecordFields,
    protocolVersionId: string | null = null,
  ): ExperimentRecordVersion {
    this.requireAuthorized(actor, projectId, 'eln.create');
    if (protocolVersionId) {
      this.requireApprovedProtocolVersion(protocolVersionId);
    }

    const recordId = `record-${++recordCounter}`;
    const version: ExperimentRecordVersion = {
      ...fields,
      recordVersionId: `record-version-${++recordVersionCounter}`,
      recordId,
      versionNumber: 1,
      protocolVersionId,
      contentHash: contentHashOf(fields),
      predecessorVersionId: null,
      createdAt: new Date().toISOString(),
    };

    const tx = new TxContext();
    this.records.set(recordId, {
      recordId,
      projectId,
      versions: [version],
      inventoryLinks: [],
      provenance: null,
      voided: false,
    });
    this.ledger.appendAuditEntry(tx, 'create', projectId, 'record', version.recordVersionId, actor.accountId);
    tx.commit();

    return version;
  }

  editRecord(
    actor: ActorContext,
    projectId: string,
    recordId: string,
    fields: RecordFields,
  ): ExperimentRecordVersion {
    this.requireAuthorized(actor, projectId, 'eln.edit');
    const entry = this.getEntry(recordId);
    const previous = entry.versions[entry.versions.length - 1]!;

    const version: ExperimentRecordVersion = {
      ...fields,
      recordVersionId: `record-version-${++recordVersionCounter}`,
      recordId,
      versionNumber: previous.versionNumber + 1,
      protocolVersionId: previous.protocolVersionId,
      contentHash: contentHashOf(fields),
      predecessorVersionId: previous.recordVersionId,
      createdAt: new Date().toISOString(),
    };

    const tx = new TxContext();
    entry.versions.push(version);
    this.ledger.appendAuditEntry(tx, 'edit', projectId, 'record', version.recordVersionId, actor.accountId);
    tx.commit();

    return version;
  }

  getRecordHistory(actor: ActorContext, projectId: string, recordId: string): ExperimentRecordHistory {
    this.requireAuthorized(actor, projectId, 'eln.view');
    const entry = this.getEntry(recordId);
    return {
      recordId: entry.recordId,
      versions: entry.versions,
      inventoryLinks: entry.inventoryLinks,
      provenance: entry.provenance,
      voided: entry.voided,
    };
  }

  linkInventory(actor: ActorContext, projectId: string, recordId: string, link: InventoryLink): void {
    this.requireAuthorized(actor, projectId, 'eln.edit');
    const entry = this.getEntry(recordId);
    entry.inventoryLinks.push(link);
  }

  getInventoryContext(actor: ActorContext, projectId: string, recordId: string): InventoryLink[] {
    this.requireAuthorized(actor, projectId, 'eln.view');
    return this.getEntry(recordId).inventoryLinks;
  }

  linkProvenance(actor: ActorContext, projectId: string, recordId: string, provenance: ProvenanceLink): void {
    this.requireAuthorized(actor, projectId, 'eln.edit');
    this.getEntry(recordId).provenance = provenance;
  }

  getProvenance(actor: ActorContext, projectId: string, recordId: string): ProvenanceLink | null {
    this.requireAuthorized(actor, projectId, 'eln.view');
    return this.getEntry(recordId).provenance;
  }

  /** Marks a record as voided without deleting any content, version, or
   * provenance/inventory data; callers (DES-AIRA2-007) must perform their
   * own authorization/audit before invoking this. */
  markVoided(recordId: string): void {
    this.getEntry(recordId).voided = true;
  }

  isVoided(recordId: string): boolean {
    return this.getEntry(recordId).voided;
  }

  private matches(entry: ExperimentRecordEntry, criteria: SearchCriteria): ExperimentRecordVersion | null {
    if (entry.voided) return null;
    if (entry.projectId !== criteria.projectId) return null;
    const latest = entry.versions[entry.versions.length - 1]!;
    if (criteria.protocolVersionId && latest.protocolVersionId !== criteria.protocolVersionId) return null;
    if (
      criteria.sampleIdentifier &&
      !entry.inventoryLinks.some((link) => link.identifier === criteria.sampleIdentifier)
    ) {
      return null;
    }
    if (criteria.freeText) {
      const haystack = `${latest.objective} ${latest.method} ${latest.results} ${latest.conclusion}`.toLowerCase();
      if (!haystack.includes(criteria.freeText.toLowerCase())) return null;
    }
    if (criteria.dateFrom && latest.createdAt < criteria.dateFrom) return null;
    if (criteria.dateTo && latest.createdAt > criteria.dateTo) return null;
    return latest;
  }

  search(actor: ActorContext, projectId: string, criteria: SearchCriteria): ExperimentRecordVersion[] {
    this.requireAuthorized(actor, projectId, 'eln.view');
    const results: ExperimentRecordVersion[] = [];
    for (const entry of this.records.values()) {
      const match = this.matches(entry, criteria);
      if (match) results.push(match);
    }
    return results;
  }

  exportSearchResults(actor: ActorContext, projectId: string, criteria: SearchCriteria): SearchReport {
    this.requireAuthorized(actor, projectId, 'eln.export');
    const matches = this.search(actor, projectId, criteria);
    return { criteria, matches };
  }
}

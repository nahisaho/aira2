import { createHash, randomUUID } from 'node:crypto';
import type { ProjectAuthorizationService, ActorContext } from '../authz/project-authz.js';
import { AuthorizationDeniedError } from '../authz/project-authz.js';
import { AuditLedger, TxContext } from '../eln-audit/ledger.js';
import type { ProtocolStore } from './protocol-store.js';
import { SqliteStore } from '../server/store.js';

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

/** @id CODE-AIRA2-ELN-002
 * @implements REQ-ELN-001 REQ-ELN-002 REQ-ELN-019 REQ-ELN-007 REQ-ELN-012 REQ-ELN-008 REQ-ELN-009 REQ-RUNTIME-002
 * @design DES-AIRA2-005
 * Every state-changing command executes inside one atomic transaction that
 * also commits its audit event via DES-AIRA2-006's ledger; every read/write
 * resolves `authorize()` via DES-AIRA2-002 with a trusted actorContext.
 */
export class ElnCoreService {
  constructor(
    private readonly authz: ProjectAuthorizationService,
    private readonly ledger: AuditLedger,
    private readonly protocolStore: ProtocolStore,
    private readonly store: SqliteStore = new SqliteStore({ dbPath: ':memory:' }),
  ) {}

  private requireAuthorized(actor: ActorContext, projectId: string, action: string): void {
    if (!this.authz.authorize(actor, projectId, action)) {
      throw new AuthorizationDeniedError(action);
    }
  }

  /** @id CODE-AIRA2-ELN-011
   * @implements REQ-MULTIUSER-011
   * @design DES-AIRA2-002
   * Requires the approved protocol version to belong to the same project as
   * the record it is being linked to; cross-project version IDs are
   * rejected with the same generic error as a missing version, to avoid
   * disclosing that a version exists in another project.
   */
  private requireApprovedProtocolVersion(projectId: string, protocolVersionId: string): void {
    const version = this.protocolStore.getVersion(protocolVersionId);
    if (!version || version.projectId !== projectId || version.status !== 'approved') {
      throw new Error(`Protocol version must be approved to link: ${protocolVersionId}`);
    }
  }

  private getEntry(recordId: string): ExperimentRecordEntry {
    const record = this.store.getExperimentRecord(recordId);
    if (!record) {
      throw new Error(`Unknown experiment record: ${recordId}`);
    }
    const versions = this.store.listExperimentRecordVersions(recordId).map((row) => ({
      recordVersionId: row.record_version_id as string,
      recordId: row.record_id as string,
      versionNumber: row.version_number as number,
      protocolVersionId: (row.protocol_version_id as string | null) ?? null,
      contentHash: row.content_hash as string,
      predecessorVersionId: (row.predecessor_version_id as string | null) ?? null,
      createdAt: row.created_at as string,
      objective: row.objective as string,
      method: row.method as string,
      rawData: row.raw_data as string,
      results: row.results as string,
      conclusion: row.conclusion as string,
    }));
    return {
      recordId: record.recordId,
      projectId: record.projectId,
      versions,
      inventoryLinks: record.inventoryLinks as unknown as InventoryLink[],
      provenance: record.provenance as unknown as ProvenanceLink | null,
      voided: record.voided,
    };
  }

  private getEntryForProject(projectId: string, recordId: string): ExperimentRecordEntry {
    const entry = this.getEntry(recordId);
    if (entry.projectId !== projectId) {
      throw new Error(`Unknown experiment record: ${recordId}`);
    }
    return entry;
  }

  private requireProtocolForProject(projectId: string, protocolId: string): void {
    const versions = this.protocolStore.listVersions(protocolId);
    if (versions.length === 0 || versions[0]!.projectId !== projectId) {
      throw new Error(`Unknown protocol: ${protocolId}`);
    }
  }

  listRecordIds(projectId: string): string[] {
    return this.store.listExperimentRecordIds(projectId);
  }

  createRecord(
    actor: ActorContext,
    projectId: string,
    fields: RecordFields,
    protocolVersionId: string | null = null,
  ): ExperimentRecordVersion {
    this.requireAuthorized(actor, projectId, 'eln.create');
    if (protocolVersionId) {
      this.requireApprovedProtocolVersion(projectId, protocolVersionId);
    }

    const recordId = `record-${randomUUID()}`;
    const version: ExperimentRecordVersion = {
      ...fields,
      recordVersionId: `record-version-${randomUUID()}`,
      recordId,
      versionNumber: 1,
      protocolVersionId,
      contentHash: contentHashOf(fields),
      predecessorVersionId: null,
      createdAt: new Date().toISOString(),
    };

    return this.store.runInTransaction(() => {
      const tx = new TxContext();
      this.store.insertExperimentRecord(recordId, projectId);
      this.store.insertExperimentRecordVersion(version);
      this.ledger.appendAuditEntry(tx, 'create', projectId, 'record', version.recordVersionId, actor.accountId);
      tx.commit();
      return version;
    });
  }

  editRecord(
    actor: ActorContext,
    projectId: string,
    recordId: string,
    fields: RecordFields,
  ): ExperimentRecordVersion {
    this.requireAuthorized(actor, projectId, 'eln.edit');
    const entry = this.getEntryForProject(projectId, recordId);
    const previous = entry.versions[entry.versions.length - 1]!;

    const version: ExperimentRecordVersion = {
      ...fields,
      recordVersionId: `record-version-${randomUUID()}`,
      recordId,
      versionNumber: previous.versionNumber + 1,
      protocolVersionId: previous.protocolVersionId,
      contentHash: contentHashOf(fields),
      predecessorVersionId: previous.recordVersionId,
      createdAt: new Date().toISOString(),
    };

    return this.store.runInTransaction(() => {
      const tx = new TxContext();
      this.store.insertExperimentRecordVersion(version);
      this.ledger.appendAuditEntry(tx, 'edit', projectId, 'record', version.recordVersionId, actor.accountId);
      tx.commit();
      return version;
    });
  }

  getRecordHistory(actor: ActorContext, projectId: string, recordId: string): ExperimentRecordHistory {
    this.requireAuthorized(actor, projectId, 'eln.view');
    const entry = this.getEntryForProject(projectId, recordId);
    return {
      recordId: entry.recordId,
      versions: entry.versions,
      inventoryLinks: entry.inventoryLinks,
      provenance: entry.provenance,
      voided: entry.voided,
    };
  }

  /** @id CODE-AIRA2-ELN-013
   * @implements REQ-ELN-005
   * @design DES-AIRA2-006
   * Wraps the inventory-link write and its audit-ledger append in the same
   * database transaction so a failed audit append rolls back the edit.
   */
  linkInventory(actor: ActorContext, projectId: string, recordId: string, link: InventoryLink): void {
    this.requireAuthorized(actor, projectId, 'eln.edit');
    const entry = this.getEntryForProject(projectId, recordId);
    const latestVersion = entry.versions[entry.versions.length - 1]!;
    this.store.runInTransaction(() => {
      const tx = new TxContext();
      this.store.setExperimentRecordInventoryLinks(recordId, [...entry.inventoryLinks, link] as unknown as Record<string, unknown>[]);
      this.ledger.appendAuditEntry(tx, 'edit', projectId, 'record', latestVersion.recordVersionId, actor.accountId);
      tx.commit();
    });
  }

  getInventoryContext(actor: ActorContext, projectId: string, recordId: string): InventoryLink[] {
    this.requireAuthorized(actor, projectId, 'eln.view');
    return this.getEntryForProject(projectId, recordId).inventoryLinks;
  }

  /** @id CODE-AIRA2-ELN-014
   * @implements REQ-ELN-005
   * @design DES-AIRA2-006
   * Wraps the provenance-link write and its audit-ledger append in the same
   * database transaction so a failed audit append rolls back the edit.
   */
  linkProvenance(actor: ActorContext, projectId: string, recordId: string, provenance: ProvenanceLink): void {
    this.requireAuthorized(actor, projectId, 'eln.edit');
    const entry = this.getEntryForProject(projectId, recordId);
    const latestVersion = entry.versions[entry.versions.length - 1]!;
    this.store.runInTransaction(() => {
      const tx = new TxContext();
      this.store.setExperimentRecordProvenance(recordId, provenance as unknown as Record<string, unknown>);
      this.ledger.appendAuditEntry(tx, 'edit', projectId, 'record', latestVersion.recordVersionId, actor.accountId);
      tx.commit();
    });
  }

  getProvenance(actor: ActorContext, projectId: string, recordId: string): ProvenanceLink | null {
    this.requireAuthorized(actor, projectId, 'eln.view');
    return this.getEntryForProject(projectId, recordId).provenance;
  }

  markVoided(projectId: string, recordId: string): void {
    this.getEntryForProject(projectId, recordId);
    this.store.setExperimentRecordVoided(recordId, true);
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
    for (const recordId of this.store.listExperimentRecordIds(projectId)) {
      const match = this.matches(this.getEntry(recordId), criteria);
      if (match) results.push(match);
    }
    return results;
  }

  exportSearchResults(actor: ActorContext, projectId: string, criteria: SearchCriteria): SearchReport {
    this.requireAuthorized(actor, projectId, 'eln.export');
    const matches = this.search(actor, projectId, criteria);
    return { criteria, matches };
  }

  createProtocol(actor: ActorContext, projectId: string, content: string) {
    this.requireAuthorized(actor, projectId, 'eln.create');
    return this.protocolStore.createProtocol(projectId, content);
  }

  createProtocolVersion(actor: ActorContext, projectId: string, protocolId: string, content: string) {
    this.requireAuthorized(actor, projectId, 'eln.edit');
    this.requireProtocolForProject(projectId, protocolId);
    return this.protocolStore.createProtocolVersion(protocolId, content);
  }

  exportRecordHistory(actor: ActorContext, projectId: string, recordId: string): ExperimentRecordHistory {
    this.requireAuthorized(actor, projectId, 'eln.export');
    const entry = this.getEntryForProject(projectId, recordId);
    this.store.runInTransaction(() => {
      const tx = new TxContext();
      this.ledger.appendAuditEntry(tx, 'export', projectId, 'record', recordId, actor.accountId);
      tx.commit();
    });
    return {
      recordId: entry.recordId,
      versions: entry.versions,
      inventoryLinks: entry.inventoryLinks,
      provenance: entry.provenance,
      voided: entry.voided,
    };
  }
}

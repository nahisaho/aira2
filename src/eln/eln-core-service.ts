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

  private requireApprovedProtocolVersion(protocolVersionId: string): void {
    const version = this.protocolStore.getVersion(protocolVersionId);
    if (!version || version.status !== 'approved') {
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
      this.requireApprovedProtocolVersion(protocolVersionId);
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

    const tx = new TxContext();
    this.store.insertExperimentRecord(recordId, projectId);
    this.store.insertExperimentRecordVersion(version);
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
      recordVersionId: `record-version-${randomUUID()}`,
      recordId,
      versionNumber: previous.versionNumber + 1,
      protocolVersionId: previous.protocolVersionId,
      contentHash: contentHashOf(fields),
      predecessorVersionId: previous.recordVersionId,
      createdAt: new Date().toISOString(),
    };

    const tx = new TxContext();
    this.store.insertExperimentRecordVersion(version);
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
    this.store.setExperimentRecordInventoryLinks(recordId, [...entry.inventoryLinks, link] as unknown as Record<string, unknown>[]);
  }

  getInventoryContext(actor: ActorContext, projectId: string, recordId: string): InventoryLink[] {
    this.requireAuthorized(actor, projectId, 'eln.view');
    return this.getEntry(recordId).inventoryLinks;
  }

  linkProvenance(actor: ActorContext, projectId: string, recordId: string, provenance: ProvenanceLink): void {
    this.requireAuthorized(actor, projectId, 'eln.edit');
    this.store.setExperimentRecordProvenance(recordId, provenance as unknown as Record<string, unknown>);
  }

  getProvenance(actor: ActorContext, projectId: string, recordId: string): ProvenanceLink | null {
    this.requireAuthorized(actor, projectId, 'eln.view');
    return this.getEntry(recordId).provenance;
  }

  markVoided(recordId: string): void {
    this.getEntry(recordId);
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
}

import { createHash } from 'node:crypto';
import { SqliteStore } from '../server/store.js';
import type { ProjectAuthorizationService, ActorContext } from '../authz/project-authz.js';
import { AuthorizationDeniedError } from '../authz/project-authz.js';

export type AuditAction = 'create' | 'edit' | 'view-sensitive' | 'approve' | 'void' | 'export' | 'delete';
export type AuditSubjectType = 'record' | 'protocol';

export interface AuditEntry {
  readonly seq: number;
  readonly projectId: string;
  readonly action: AuditAction;
  readonly subjectType: AuditSubjectType;
  readonly subjectVersionId: string;
  readonly actorAccountId: string;
  readonly timestamp: string;
  readonly beforeRef: string | null;
  readonly afterRef: string | null;
  readonly prevHash: string | null;
  readonly hash: string;
}

/** @id CODE-AIRA2-AUDIT-001
 * @implements REQ-ELN-005
 * @design DES-AIRA2-006
 * Transaction marker required by appendAuditEntry: audit entries may only be
 * appended from within an active transaction opened by the calling
 * DES-AIRA2-005/007 command.
 */
export class TxContext {
  private active = true;
  isActive(): boolean {
    return this.active;
  }
  commit(): void {
    this.active = false;
  }
}

function canonicalPayload(entry: Omit<AuditEntry, 'hash'>): string {
  return JSON.stringify(entry);
}

function computeHash(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalPayload(entry)).digest('hex');
}

/** @id CODE-AIRA2-AUDIT-002
 * @implements REQ-ELN-005 REQ-ELN-011 REQ-RUNTIME-002
 * @design DES-AIRA2-006
 * Append-only, hash-chained, per-project sequenced audit log. There is
 * intentionally no update/delete method: the only mutation path is
 * `__testOnlyMutateEntry`, reserved for tests that simulate an
 * out-of-band alteration outside this normal recording process.
 */
export class AuditLedger {
  private readonly tamperedEntries = new Map<string, Map<number, AuditEntry>>();

  constructor(
    private readonly store: SqliteStore = new SqliteStore({ dbPath: ':memory:' }),
    private readonly authz?: ProjectAuthorizationService,
  ) {}

  appendAuditEntry(
    txContext: TxContext,
    action: AuditAction,
    projectId: string,
    subjectType: AuditSubjectType,
    subjectVersionId: string,
    actorAccountId: string,
    refs: { beforeRef?: string | null; afterRef?: string | null } = {},
  ): AuditEntry {
    if (!txContext.isActive()) {
      throw new Error('appendAuditEntry requires an active transaction');
    }
    const projectEntries = this.listEntries(projectId);
    const prevHash = projectEntries.length > 0 ? projectEntries[projectEntries.length - 1]!.hash : null;
    const unhashed: Omit<AuditEntry, 'hash'> = {
      seq: projectEntries.length + 1,
      projectId,
      action,
      subjectType,
      subjectVersionId,
      actorAccountId,
      timestamp: new Date().toISOString(),
      beforeRef: refs.beforeRef ?? null,
      afterRef: refs.afterRef ?? null,
      prevHash,
    };
    const entry: AuditEntry = { ...unhashed, hash: computeHash(unhashed) };
    this.store.appendAuditEntry(entry);
    return entry;
  }

  listEntries(projectId: string): readonly AuditEntry[] {
    const rows = this.store.listAuditEntries(projectId).map((row) => ({
      seq: row.seq as number,
      projectId: row.project_id as string,
      action: row.action as AuditAction,
      subjectType: row.subject_type as AuditSubjectType,
      subjectVersionId: row.subject_version_id as string,
      actorAccountId: row.actor_account_id as string,
      timestamp: row.timestamp as string,
      beforeRef: (row.before_ref as string | null) ?? null,
      afterRef: (row.after_ref as string | null) ?? null,
      prevHash: (row.prev_hash as string | null) ?? null,
      hash: row.hash as string,
    }));
    const tampered = this.tamperedEntries.get(projectId);
    if (!tampered) return rows;
    return rows.map((entry) => tampered.get(entry.seq) ?? entry);
  }

  listEntriesForSubject(projectId: string, subjectType: AuditSubjectType, subjectVersionId: string): AuditEntry[] {
    return this.store.listAuditEntries(projectId, subjectType, subjectVersionId).map((row) => ({
      seq: row.seq as number,
      projectId: row.project_id as string,
      action: row.action as AuditAction,
      subjectType: row.subject_type as AuditSubjectType,
      subjectVersionId: row.subject_version_id as string,
      actorAccountId: row.actor_account_id as string,
      timestamp: row.timestamp as string,
      beforeRef: (row.before_ref as string | null) ?? null,
      afterRef: (row.after_ref as string | null) ?? null,
      prevHash: (row.prev_hash as string | null) ?? null,
      hash: row.hash as string,
    }));
  }

  /** @id CODE-AIRA2-AUDIT-004
   * @implements REQ-RUNTIME-003 REQ-MULTIUSER-011
   * @design DES-AIRA2-006
   */
  getAuditHistory(
    actor: ActorContext,
    projectId: string,
    subjectType: AuditSubjectType,
    subjectVersionId: string,
  ): AuditEntry[] {
    if (!this.authz?.authorize(actor, projectId, 'eln.audit-history.view')) {
      throw new AuthorizationDeniedError('eln.audit-history.view');
    }
    return this.listEntriesForSubject(projectId, subjectType, subjectVersionId);
  }

  /** Test-only: simulates a persisted audit entry being altered outside the
   * normal recording process, to exercise tamper detection. Never used by
   * production callers. */
  __testOnlyMutateEntry(projectId: string, seq: number, mutate: (entry: AuditEntry) => AuditEntry): void {
    const entries = this.listEntries(projectId);
    const current = entries.find((entry) => entry.seq === seq);
    if (!current) return;
    const projectTampered = this.tamperedEntries.get(projectId) ?? new Map<number, AuditEntry>();
    projectTampered.set(seq, mutate(current));
    this.tamperedEntries.set(projectId, projectTampered);
  }

  detectTamperedEntries(projectId: string): number[] {
    const entries = this.listEntries(projectId);
    const tampered: number[] = [];
    let expectedPrevHash: string | null = null;
    for (const entry of entries) {
      const { hash, ...rest } = entry;
      const recomputed = computeHash(rest);
      if (recomputed !== hash || entry.prevHash !== expectedPrevHash) {
        tampered.push(entry.seq);
      }
      expectedPrevHash = hash;
    }
    return tampered;
  }
}

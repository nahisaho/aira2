import { createHash } from 'node:crypto';

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
 * @implements REQ-ELN-005 REQ-ELN-011
 * @design DES-AIRA2-006
 * Append-only, hash-chained, per-project sequenced audit log. There is
 * intentionally no update/delete method: the only mutation path is
 * `__testOnlyMutateEntry`, reserved for tests that simulate an
 * out-of-band alteration outside this normal recording process.
 */
export class AuditLedger {
  private readonly entriesByProject = new Map<string, AuditEntry[]>();

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
    const projectEntries = this.entriesByProject.get(projectId) ?? [];
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
    projectEntries.push(entry);
    this.entriesByProject.set(projectId, projectEntries);
    return entry;
  }

  listEntries(projectId: string): readonly AuditEntry[] {
    return this.entriesByProject.get(projectId) ?? [];
  }

  /** Test-only: simulates a persisted audit entry being altered outside the
   * normal recording process, to exercise tamper detection. Never used by
   * production callers. */
  __testOnlyMutateEntry(projectId: string, seq: number, mutate: (entry: AuditEntry) => AuditEntry): void {
    const entries = this.entriesByProject.get(projectId);
    if (!entries) return;
    const index = entries.findIndex((e) => e.seq === seq);
    if (index === -1) return;
    const current = entries[index];
    if (!current) return;
    entries[index] = mutate(current);
  }

  /** Recomputes each entry's hash from its stored payload and compares
   * against the stored hash and chain linkage, returning the seq numbers
   * of any entries that no longer match. */
  detectTamperedEntries(projectId: string): number[] {
    const entries = this.entriesByProject.get(projectId) ?? [];
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

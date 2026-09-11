/** @id CODE-AIRA2-AUTHZ-003
 * @implements REQ-MULTIUSER-006
 * @design DES-AIRA2-002
 */
export interface AuditEntry {
  userId: string;
  timestamp: number;
  actionType: string;
  targetResource: string;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  list(): readonly AuditEntry[] {
    return this.entries;
  }
}

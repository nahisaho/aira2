import { SqliteStore } from '../server/store.js';

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

  constructor(private readonly store?: SqliteStore) {}

  record(entry: AuditEntry): void {
    if (this.store) {
      this.store.appendAuthzAudit(entry);
      return;
    }
    this.entries.push(entry);
  }

  list(): readonly AuditEntry[] {
    if (this.store) {
      return this.store.listAuthzAudit();
    }
    return this.entries;
  }
}

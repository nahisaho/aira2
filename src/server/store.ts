import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_DB_PATH = './data/aira2.sqlite';

export interface SqliteStoreOptions {
  dbPath?: string;
}

type JsonValue = unknown;

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  return JSON.parse(value) as T;
}

/** @id CODE-AIRA2-RUNTIME-001
 * @implements REQ-RUNTIME-002 REQ-RUNTIME-005
 * @design DES-AIRA2-011
 */
export class SqliteStore {
  readonly db: Database.Database;

  constructor(options: SqliteStoreOptions = {}) {
    const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  runInTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS password_credentials (
        external_identity TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_owners (
        project_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_shares (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS authz_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        action_type TEXT NOT NULL,
        target_resource TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        owner_account_id TEXT,
        encrypted_json TEXT NOT NULL,
        mask_hint TEXT NOT NULL,
        UNIQUE(provider, scope, owner_account_id)
      );
      CREATE TABLE IF NOT EXISTS user_backend_defaults (
        owner_user_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_backend_overrides (
        project_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS protocols (
        protocol_version_id TEXT PRIMARY KEY,
        protocol_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_records (
        record_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        inventory_links_json TEXT NOT NULL,
        provenance_json TEXT,
        voided INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_record_versions (
        record_version_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        protocol_version_id TEXT,
        content_hash TEXT NOT NULL,
        predecessor_version_id TEXT,
        created_at TEXT NOT NULL,
        objective TEXT NOT NULL,
        method TEXT NOT NULL,
        raw_data TEXT NOT NULL,
        results TEXT NOT NULL,
        conclusion TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_entries (
        project_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        action TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_version_id TEXT NOT NULL,
        actor_account_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        before_ref TEXT,
        after_ref TEXT,
        prev_hash TEXT,
        hash TEXT NOT NULL,
        PRIMARY KEY (project_id, seq)
      );
      CREATE TABLE IF NOT EXISTS integrity_state (
        project_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        last_report_json TEXT
      );
      CREATE TABLE IF NOT EXISTS signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_skills (
        project_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        PRIMARY KEY (project_id, skill_id)
      );
      CREATE TABLE IF NOT EXISTS mcp_servers (
        project_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        PRIMARY KEY (project_id, server_id)
      );
      CREATE TABLE IF NOT EXISTS agent_skill_sources (
        source_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        access_credential_ref TEXT NOT NULL,
        available_skill_ids_json TEXT NOT NULL
      );
    `);
  }

  upsertAccount(accountId: string, payload: JsonValue): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, payload_json) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(accountId, JSON.stringify(payload));
  }

  getAccount<T>(accountId: string): T | undefined {
    const row = this.db.prepare(`SELECT payload_json FROM accounts WHERE id = ?`).get(accountId) as
      | { payload_json: string }
      | undefined;
    return row ? (JSON.parse(row.payload_json) as T) : undefined;
  }

  upsertSession(sessionId: string, accountId: string, payload: JsonValue): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, account_id, payload_json) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, payload_json = excluded.payload_json`,
      )
      .run(sessionId, accountId, JSON.stringify(payload));
  }

  getSession<T>(sessionId: string): T | undefined {
    const row = this.db.prepare(`SELECT payload_json FROM sessions WHERE id = ?`).get(sessionId) as
      | { payload_json: string }
      | undefined;
    return row ? (JSON.parse(row.payload_json) as T) : undefined;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  upsertPasswordCredential(externalIdentity: string, passwordHash: string): void {
    this.db
      .prepare(
        `INSERT INTO password_credentials (external_identity, password_hash) VALUES (?, ?)
         ON CONFLICT(external_identity) DO UPDATE SET password_hash = excluded.password_hash`,
      )
      .run(externalIdentity, passwordHash);
  }

  getPasswordCredential(externalIdentity: string): string | null {
    const row = this.db
      .prepare(`SELECT password_hash FROM password_credentials WHERE external_identity = ?`)
      .get(externalIdentity) as { password_hash: string } | undefined;
    return row?.password_hash ?? null;
  }

  countPasswordCredentials(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM password_credentials`)
      .get() as { count: number };
    return row.count;
  }

  setProjectOwner(projectId: string, ownerUserId: string): void {
    this.db
      .prepare(
        `INSERT INTO project_owners (project_id, owner_user_id) VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET owner_user_id = excluded.owner_user_id`,
      )
      .run(projectId, ownerUserId);
  }

  getProjectOwner(projectId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT owner_user_id FROM project_owners WHERE project_id = ?`)
      .get(projectId) as { owner_user_id: string } | undefined;
    return row?.owner_user_id;
  }

  setProjectShare(projectId: string, userId: string, role: string): void {
    this.db
      .prepare(
        `INSERT INTO project_shares (project_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(projectId, userId, role);
  }

  getProjectShare(projectId: string, userId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT role FROM project_shares WHERE project_id = ? AND user_id = ?`)
      .get(projectId, userId) as { role: string } | undefined;
    return row?.role;
  }

  deleteProjectShare(projectId: string, userId: string): void {
    this.db.prepare(`DELETE FROM project_shares WHERE project_id = ? AND user_id = ?`).run(projectId, userId);
  }

  appendAuthzAudit(entry: { userId: string; timestamp: number; actionType: string; targetResource: string }): void {
    this.db
      .prepare(
        `INSERT INTO authz_audit_log (user_id, timestamp, action_type, target_resource) VALUES (?, ?, ?, ?)`,
      )
      .run(entry.userId, entry.timestamp, entry.actionType, entry.targetResource);
  }

  listAuthzAudit(): Array<{ userId: string; timestamp: number; actionType: string; targetResource: string }> {
    return this.db
      .prepare(
        `SELECT user_id, timestamp, action_type, target_resource FROM authz_audit_log ORDER BY id ASC`,
      )
      .all()
      .map((row) => {
        const typed = row as {
          user_id: string;
          timestamp: number;
          action_type: string;
          target_resource: string;
        };
        return {
          userId: typed.user_id,
          timestamp: typed.timestamp,
          actionType: typed.action_type,
          targetResource: typed.target_resource,
        };
      });
  }

  upsertCredential(row: {
    id: string;
    provider: string;
    scope: string;
    ownerAccountId: string | null;
    encrypted: JsonValue;
    maskHint: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO credentials (id, provider, scope, owner_account_id, encrypted_json, mask_hint)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           scope = excluded.scope,
           owner_account_id = excluded.owner_account_id,
           encrypted_json = excluded.encrypted_json,
           mask_hint = excluded.mask_hint`,
      )
      .run(row.id, row.provider, row.scope, row.ownerAccountId, JSON.stringify(row.encrypted), row.maskHint);
  }

  getCredential(provider: string, scope: string, ownerAccountId: string | null): {
    id: string;
    provider: string;
    scope: string;
    ownerAccountId: string | null;
    encrypted: JsonValue;
    maskHint: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, provider, scope, owner_account_id, encrypted_json, mask_hint
         FROM credentials WHERE provider = ? AND scope = ? AND owner_account_id IS ?`,
      )
      .get(provider, scope, ownerAccountId) as
      | {
          id: string;
          provider: string;
          scope: string;
          owner_account_id: string | null;
          encrypted_json: string;
          mask_hint: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      scope: row.scope,
      ownerAccountId: row.owner_account_id,
      encrypted: JSON.parse(row.encrypted_json) as JsonValue,
      maskHint: row.mask_hint,
    };
  }

  listCredentials(ownerAccountId?: string | null): Array<{
    id: string;
    provider: string;
    scope: string;
    ownerAccountId: string | null;
    encrypted: JsonValue;
    maskHint: string;
  }> {
    const rows = ownerAccountId === undefined
      ? (this.db.prepare(`SELECT id, provider, scope, owner_account_id, encrypted_json, mask_hint FROM credentials ORDER BY id ASC`).all() as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, provider, scope, owner_account_id, encrypted_json, mask_hint
             FROM credentials WHERE owner_account_id IS ? ORDER BY id ASC`,
          )
          .all(ownerAccountId) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: row.id as string,
      provider: row.provider as string,
      scope: row.scope as string,
      ownerAccountId: (row.owner_account_id as string | null) ?? null,
      encrypted: JSON.parse(row.encrypted_json as string) as JsonValue,
      maskHint: row.mask_hint as string,
    }));
  }

  hasAdminCredential(provider: string): boolean {
    return this.getCredential(provider, 'admin-shared', null) !== null;
  }

  setUserBackendDefault(ownerUserId: string, providerId: string, model: string): void {
    this.db
      .prepare(
        `INSERT INTO user_backend_defaults (owner_user_id, provider_id, model) VALUES (?, ?, ?)
         ON CONFLICT(owner_user_id) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`,
      )
      .run(ownerUserId, providerId, model);
  }

  getUserBackendDefault(ownerUserId: string): { providerId: string; model: string } | null {
    const row = this.db
      .prepare(`SELECT provider_id, model FROM user_backend_defaults WHERE owner_user_id = ?`)
      .get(ownerUserId) as { provider_id: string; model: string } | undefined;
    return row ? { providerId: row.provider_id, model: row.model } : null;
  }

  setProjectBackendOverride(projectId: string, providerId: string, model: string): void {
    this.db
      .prepare(
        `INSERT INTO project_backend_overrides (project_id, provider_id, model) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`,
      )
      .run(projectId, providerId, model);
  }

  getProjectBackendOverride(projectId: string): { providerId: string; model: string } | null {
    const row = this.db
      .prepare(`SELECT provider_id, model FROM project_backend_overrides WHERE project_id = ?`)
      .get(projectId) as { provider_id: string; model: string } | undefined;
    return row ? { providerId: row.provider_id, model: row.model } : null;
  }

  insertProtocolVersion(version: {
    protocolVersionId: string;
    protocolId: string;
    projectId: string;
    versionNumber: number;
    content: string;
    status: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO protocols (protocol_version_id, protocol_id, project_id, version_number, content, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.protocolVersionId,
        version.protocolId,
        version.projectId,
        version.versionNumber,
        version.content,
        version.status,
      );
  }

  listProtocolVersions(protocolId: string): Array<{
    protocolVersionId: string;
    protocolId: string;
    projectId: string;
    versionNumber: number;
    content: string;
    status: string;
  }> {
    return (this.db
      .prepare(
        `SELECT protocol_version_id, protocol_id, project_id, version_number, content, status
         FROM protocols WHERE protocol_id = ? ORDER BY version_number ASC`,
      )
      .all(protocolId) as Array<Record<string, unknown>>).map((row) => ({
      protocolVersionId: row.protocol_version_id as string,
      protocolId: row.protocol_id as string,
      projectId: row.project_id as string,
      versionNumber: row.version_number as number,
      content: row.content as string,
      status: row.status as string,
    }));
  }

  listProtocolVersionsByProject(projectId: string): Array<{
    protocolVersionId: string;
    protocolId: string;
    projectId: string;
    versionNumber: number;
    content: string;
    status: string;
  }> {
    return (this.db
      .prepare(
        `SELECT protocol_version_id, protocol_id, project_id, version_number, content, status
         FROM protocols WHERE project_id = ? ORDER BY protocol_id ASC, version_number ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>).map((row) => ({
      protocolVersionId: row.protocol_version_id as string,
      protocolId: row.protocol_id as string,
      projectId: row.project_id as string,
      versionNumber: row.version_number as number,
      content: row.content as string,
      status: row.status as string,
    }));
  }

  getProtocolVersion(protocolVersionId: string): {
    protocolVersionId: string;
    protocolId: string;
    projectId: string;
    versionNumber: number;
    content: string;
    status: string;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT protocol_version_id, protocol_id, project_id, version_number, content, status
         FROM protocols WHERE protocol_version_id = ?`,
      )
      .get(protocolVersionId) as Record<string, unknown> | undefined;
    return row
      ? {
          protocolVersionId: row.protocol_version_id as string,
          protocolId: row.protocol_id as string,
          projectId: row.project_id as string,
          versionNumber: row.version_number as number,
          content: row.content as string,
          status: row.status as string,
        }
      : undefined;
  }

  setProtocolStatus(protocolVersionId: string, status: string): void {
    this.db.prepare(`UPDATE protocols SET status = ? WHERE protocol_version_id = ?`).run(status, protocolVersionId);
  }

  insertExperimentRecord(recordId: string, projectId: string): void {
    this.db
      .prepare(
        `INSERT INTO experiment_records (record_id, project_id, inventory_links_json, provenance_json, voided)
         VALUES (?, ?, '[]', NULL, 0)`,
      )
      .run(recordId, projectId);
  }

  getExperimentRecord(recordId: string): {
    recordId: string;
    projectId: string;
    inventoryLinks: JsonValue;
    provenance: JsonValue | null;
    voided: boolean;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT record_id, project_id, inventory_links_json, provenance_json, voided
         FROM experiment_records WHERE record_id = ?`,
      )
      .get(recordId) as Record<string, unknown> | undefined;
    return row
      ? {
          recordId: row.record_id as string,
          projectId: row.project_id as string,
          inventoryLinks: JSON.parse(row.inventory_links_json as string) as JsonValue,
          provenance: parseJson<JsonValue>((row.provenance_json as string | null) ?? null),
          voided: (row.voided as number) === 1,
        }
      : undefined;
  }

  listExperimentRecordIds(projectId?: string): string[] {
    if (projectId) {
      return (this.db
        .prepare(`SELECT record_id FROM experiment_records WHERE project_id = ? ORDER BY rowid ASC`)
        .all(projectId) as Array<{ record_id: string }>).map((row) => row.record_id);
    }
    return (this.db.prepare(`SELECT record_id FROM experiment_records ORDER BY rowid ASC`).all() as Array<{ record_id: string }>).map((row) => row.record_id);
  }

  setExperimentRecordInventoryLinks(recordId: string, inventoryLinks: JsonValue): void {
    this.db
      .prepare(`UPDATE experiment_records SET inventory_links_json = ? WHERE record_id = ?`)
      .run(JSON.stringify(inventoryLinks), recordId);
  }

  setExperimentRecordProvenance(recordId: string, provenance: JsonValue | null): void {
    this.db
      .prepare(`UPDATE experiment_records SET provenance_json = ? WHERE record_id = ?`)
      .run(provenance === null ? null : JSON.stringify(provenance), recordId);
  }

  setExperimentRecordVoided(recordId: string, voided: boolean): void {
    this.db.prepare(`UPDATE experiment_records SET voided = ? WHERE record_id = ?`).run(voided ? 1 : 0, recordId);
  }

  insertExperimentRecordVersion(version: {
    recordVersionId: string;
    recordId: string;
    versionNumber: number;
    protocolVersionId: string | null;
    contentHash: string;
    predecessorVersionId: string | null;
    createdAt: string;
    objective: string;
    method: string;
    rawData: string;
    results: string;
    conclusion: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO experiment_record_versions (
          record_version_id, record_id, version_number, protocol_version_id, content_hash,
          predecessor_version_id, created_at, objective, method, raw_data, results, conclusion
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.recordVersionId,
        version.recordId,
        version.versionNumber,
        version.protocolVersionId,
        version.contentHash,
        version.predecessorVersionId,
        version.createdAt,
        version.objective,
        version.method,
        version.rawData,
        version.results,
        version.conclusion,
      );
  }

  listExperimentRecordVersions(recordId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT
          record_version_id, record_id, version_number, protocol_version_id, content_hash,
          predecessor_version_id, created_at, objective, method, raw_data, results, conclusion
         FROM experiment_record_versions WHERE record_id = ? ORDER BY version_number ASC`,
      )
      .all(recordId) as Array<Record<string, unknown>>;
  }

  appendAuditEntry(entry: {
    projectId: string;
    seq: number;
    action: string;
    subjectType: string;
    subjectVersionId: string;
    actorAccountId: string;
    timestamp: string;
    beforeRef: string | null;
    afterRef: string | null;
    prevHash: string | null;
    hash: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_entries (
          project_id, seq, action, subject_type, subject_version_id, actor_account_id,
          timestamp, before_ref, after_ref, prev_hash, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.projectId,
        entry.seq,
        entry.action,
        entry.subjectType,
        entry.subjectVersionId,
        entry.actorAccountId,
        entry.timestamp,
        entry.beforeRef,
        entry.afterRef,
        entry.prevHash,
        entry.hash,
      );
  }

  listAuditEntries(projectId: string, subjectType?: string, subjectVersionId?: string): Array<Record<string, unknown>> {
    if (subjectType && subjectVersionId) {
      return this.db
        .prepare(
          `SELECT project_id, seq, action, subject_type, subject_version_id, actor_account_id,
                  timestamp, before_ref, after_ref, prev_hash, hash
           FROM audit_entries
           WHERE project_id = ? AND subject_type = ? AND subject_version_id = ?
           ORDER BY seq ASC`,
        )
        .all(projectId, subjectType, subjectVersionId) as Array<Record<string, unknown>>;
    }
    return this.db
      .prepare(
        `SELECT project_id, seq, action, subject_type, subject_version_id, actor_account_id,
                timestamp, before_ref, after_ref, prev_hash, hash
         FROM audit_entries WHERE project_id = ? ORDER BY seq ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
  }

  setIntegrityState(projectId: string, state: string, lastReport: JsonValue | null): void {
    this.db
      .prepare(
        `INSERT INTO integrity_state (project_id, state, last_report_json) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, last_report_json = excluded.last_report_json`,
      )
      .run(projectId, state, lastReport === null ? null : JSON.stringify(lastReport));
  }

  getIntegrityState(projectId: string): { state: string; lastReport: JsonValue | null } | null {
    const row = this.db
      .prepare(`SELECT state, last_report_json FROM integrity_state WHERE project_id = ?`)
      .get(projectId) as { state: string; last_report_json: string | null } | undefined;
    return row ? { state: row.state, lastReport: parseJson<JsonValue>(row.last_report_json) } : null;
  }

  insertSignature(recordId: string, payload: JsonValue): void {
    this.db.prepare(`INSERT INTO signatures (record_id, payload_json) VALUES (?, ?)`).run(recordId, JSON.stringify(payload));
  }

  listSignatures<T>(recordId: string): T[] {
    return (this.db
      .prepare(`SELECT payload_json FROM signatures WHERE record_id = ? ORDER BY id ASC`)
      .all(recordId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as T);
  }

  replaceAgentSkills(projectId: string, skills: Array<{ skillId: string; enabled: boolean }>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM agent_skills WHERE project_id = ?`).run(projectId);
      const insert = this.db.prepare(`INSERT INTO agent_skills (project_id, skill_id, enabled) VALUES (?, ?, ?)`);
      for (const skill of skills) {
        insert.run(projectId, skill.skillId, skill.enabled ? 1 : 0);
      }
    });
    tx();
  }

  getAgentSkills(projectId: string): Array<{ skillId: string; enabled: boolean }> {
    return (this.db
      .prepare(`SELECT skill_id, enabled FROM agent_skills WHERE project_id = ? ORDER BY skill_id ASC`)
      .all(projectId) as Array<{ skill_id: string; enabled: number }>).map((row) => ({
      skillId: row.skill_id,
      enabled: row.enabled === 1,
    }));
  }

  replaceMcpServers(
    projectId: string,
    servers: Array<{ serverId: string; command: string; args: string[]; enabled: boolean }>,
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM mcp_servers WHERE project_id = ?`).run(projectId);
      const insert = this.db.prepare(
        `INSERT INTO mcp_servers (project_id, server_id, command, args_json, enabled) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const server of servers) {
        insert.run(projectId, server.serverId, server.command, JSON.stringify(server.args), server.enabled ? 1 : 0);
      }
    });
    tx();
  }

  getMcpServers(projectId: string): Array<{ serverId: string; command: string; args: string[]; enabled: boolean }> {
    return (this.db
      .prepare(`SELECT server_id, command, args_json, enabled FROM mcp_servers WHERE project_id = ? ORDER BY server_id ASC`)
      .all(projectId) as Array<{ server_id: string; command: string; args_json: string; enabled: number }>).map((row) => ({
      serverId: row.server_id,
      command: row.command,
      args: JSON.parse(row.args_json) as string[],
      enabled: row.enabled === 1,
    }));
  }

  putAgentSkillSource(source: {
    sourceId: string;
    projectId: string;
    repositoryUrl: string;
    accessCredentialRef: string;
    availableSkillIds: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_skill_sources (
          source_id, project_id, repository_url, access_credential_ref, available_skill_ids_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          project_id = excluded.project_id,
          repository_url = excluded.repository_url,
          access_credential_ref = excluded.access_credential_ref,
          available_skill_ids_json = excluded.available_skill_ids_json`,
      )
      .run(
        source.sourceId,
        source.projectId,
        source.repositoryUrl,
        source.accessCredentialRef,
        JSON.stringify(source.availableSkillIds),
      );
  }

  getAgentSkillSource(sourceId: string): {
    sourceId: string;
    projectId: string;
    repositoryUrl: string;
    accessCredentialRef: string;
    availableSkillIds: string[];
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT source_id, project_id, repository_url, access_credential_ref, available_skill_ids_json
         FROM agent_skill_sources WHERE source_id = ?`,
      )
      .get(sourceId) as Record<string, unknown> | undefined;
    return row
      ? {
          sourceId: row.source_id as string,
          projectId: row.project_id as string,
          repositoryUrl: row.repository_url as string,
          accessCredentialRef: row.access_credential_ref as string,
          availableSkillIds: JSON.parse(row.available_skill_ids_json as string) as string[],
        }
      : undefined;
  }

  listAgentSkillSources(projectId: string): string[] {
    return (this.db
      .prepare(`SELECT source_id FROM agent_skill_sources WHERE project_id = ? ORDER BY source_id ASC`)
      .all(projectId) as Array<{ source_id: string }>).map((row) => row.source_id);
  }

  deleteAgentSkillSource(sourceId: string): void {
    this.db.prepare(`DELETE FROM agent_skill_sources WHERE source_id = ?`).run(sourceId);
  }
}

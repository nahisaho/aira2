import { isProjectActionAllowed, type ProjectRole } from './matrix.js';
import type { AuditLog } from './audit.js';
import { SqliteStore } from '../server/store.js';

export interface ActorContext {
  accountId: string;
  isGlobalAdmin?: boolean;
}

export interface RevocationNotifier {
  terminateSessionsAndConnections(projectId: string, userId: string): void;
}

export class AuthorizationDeniedError extends Error {
  constructor(action: string) {
    super(`Authorization denied for action: ${action}`);
  }
}

/** @id CODE-AIRA2-AUTHZ-002
 * @implements REQ-MULTIUSER-003 REQ-MULTIUSER-004 REQ-MULTIUSER-005 REQ-MULTIUSER-006 REQ-MULTIUSER-008 REQ-MULTIUSER-011 REQ-MULTIUSER-012
 * @design DES-AIRA2-002
 */
export class ProjectAuthorizationService {
  constructor(
    private readonly audit: AuditLog,
    private readonly notifier: RevocationNotifier,
    private readonly store: SqliteStore = new SqliteStore({ dbPath: ':memory:' }),
  ) {}

  createProject(ownerId: string, projectId: string): void {
    this.store.setProjectOwner(projectId, ownerId);
  }

  getRole(projectId: string, userId: string): ProjectRole | undefined {
    if (this.store.getProjectOwner(projectId) === userId) {
      return 'owner';
    }
    return this.store.getProjectShare(projectId, userId) as ProjectRole | undefined;
  }

  authorize(actor: ActorContext, projectId: string, action: string): boolean {
    if (action === 'project.share.manage' && actor.isGlobalAdmin) {
      return true;
    }
    const role = this.getRole(projectId, actor.accountId);
    return isProjectActionAllowed(role, action);
  }

  grantShare(
    actor: ActorContext,
    projectId: string,
    targetUserId: string,
    role: ProjectRole,
  ): void {
    if (!this.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    this.store.setProjectShare(projectId, targetUserId, role);
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'project.share.grant',
      targetResource: `project:${projectId}:user:${targetUserId}`,
    });
  }

  revokeShare(actor: ActorContext, projectId: string, targetUserId: string): void {
    if (!this.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    // Revocation only removes the share mapping and notifies session/MCP
    // termination; it must never read or mutate signature-attribution
    // records owned by DES-AIRA2-007 (REQ-MULTIUSER-012).
    this.store.deleteProjectShare(projectId, targetUserId);
    this.notifier.terminateSessionsAndConnections(projectId, targetUserId);
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'project.share.revoke',
      targetResource: `project:${projectId}:user:${targetUserId}`,
    });
  }
}

import { isProjectActionAllowed, type ProjectRole } from './matrix.js';
import type { AuditLog } from './audit.js';

export interface ActorContext {
  accountId: string;
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
  private readonly owners = new Map<string, string>();
  private readonly shares = new Map<string, ProjectRole>();

  constructor(
    private readonly audit: AuditLog,
    private readonly notifier: RevocationNotifier,
  ) {}

  private shareKey(projectId: string, userId: string): string {
    return `${projectId}:${userId}`;
  }

  createProject(ownerId: string, projectId: string): void {
    this.owners.set(projectId, ownerId);
  }

  getRole(projectId: string, userId: string): ProjectRole | undefined {
    if (this.owners.get(projectId) === userId) {
      return 'owner';
    }
    return this.shares.get(this.shareKey(projectId, userId));
  }

  authorize(actor: ActorContext, projectId: string, action: string): boolean {
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
    this.shares.set(this.shareKey(projectId, targetUserId), role);
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
    this.shares.delete(this.shareKey(projectId, targetUserId));
    this.notifier.terminateSessionsAndConnections(projectId, targetUserId);
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'project.share.revoke',
      targetResource: `project:${projectId}:user:${targetUserId}`,
    });
  }
}

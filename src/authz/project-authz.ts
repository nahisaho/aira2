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

/**
 * Narrow team-share query consumed by `ProjectAuthorizationService.getRole` so
 * every authorization decision honors team-based grants without creating a
 * construction-order cycle with `TeamService` (REQ-MULTIUSER-017/031).
 */
export interface TeamShareResolver {
  resolveTeamOnlyRole(userId: string, projectId: string): 'editor' | 'viewer' | 'none';
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
  private teamShareResolver: TeamShareResolver | undefined;

  constructor(
    private readonly audit: AuditLog,
    private readonly notifier: RevocationNotifier,
    private readonly store: SqliteStore = new SqliteStore({ dbPath: ':memory:' }),
  ) {}

  /** Wired once by the composition root after `TeamService` is constructed (REQ-MULTIUSER-017/031). */
  setTeamShareResolver(resolver: TeamShareResolver): void {
    this.teamShareResolver = resolver;
  }

  createProject(ownerId: string, projectId: string): void {
    this.store.setProjectOwner(projectId, ownerId);
  }

  getRole(projectId: string, userId: string): ProjectRole | undefined {
    if (this.store.getProjectOwner(projectId) === userId) {
      return 'owner';
    }
    const direct = this.store.getProjectShare(projectId, userId) as ProjectRole | undefined;
    const teamRole = this.teamShareResolver?.resolveTeamOnlyRole(userId, projectId) ?? 'none';
    if (direct === 'editor' || teamRole === 'editor') {
      return 'editor';
    }
    if (direct) {
      return direct;
    }
    return teamRole === 'viewer' ? 'viewer' : undefined;
  }

  /** Public accessor consumed by DES-AIRA2-013 for last-owner protection (REQ-MULTIUSER-029). */
  getProjectOwner(projectId: string): string | undefined {
    return this.store.getProjectOwner(projectId);
  }

  /** Public accessor consumed by DES-AIRA2-013's member-management UI backing (REQ-MULTIUSER-015). */
  listMemberRoles(projectId: string): { userId: string; role: string }[] {
    const ownerId = this.store.getProjectOwner(projectId);
    const shares = this.store.listProjectShares(projectId);
    const members = ownerId ? [{ userId: ownerId, role: 'owner' }] : [];
    return [...members, ...shares];
  }

  /**
   * Terminates a project's sessions/MCP connections for a user without deleting any direct
   * share record — consumed by DES-AIRA2-013 when a team-based grant is the sole source of a
   * user's access and that access is revoked (REQ-MULTIUSER-026), via the same notifier used
   * by `revokeShare` for direct-share revocation.
   */
  terminateForRevokedAccess(projectId: string, userId: string): void {
    this.notifier.terminateSessionsAndConnections(projectId, userId);
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

  /**
   * Grants a share without an `authorize()` check, for the sole case where the grant's
   * legitimacy was already established by a different atomic gate — DES-AIRA2-013's invitation
   * acceptance, which is authorized by token possession plus verified-email match rather than
   * the accepting user's own project role (REQ-MULTIUSER-014/039).
   */
  grantShareViaInvitation(projectId: string, targetUserId: string, role: ProjectRole): void {
    this.store.setProjectShare(projectId, targetUserId, role);
    this.audit.record({
      userId: targetUserId,
      timestamp: Date.now(),
      actionType: 'project.share.grant-via-invitation',
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

import { randomBytes } from 'node:crypto';
import { authorizeSelf, type SelfScopeActorContext } from './self-scope.js';
import { AuditLog } from './audit.js';
import { AuthorizationDeniedError, ProjectAuthorizationService, type ActorContext } from './project-authz.js';

export type TeamShareRole = 'viewer' | 'editor';
export type EffectiveRole = 'owner' | 'editor' | 'viewer' | 'none';
export type InvitationStatus = 'pending' | 'accepted' | 'cancelled' | 'expired';

export interface Team {
  id: string;
  name: string;
  adminUserId: string;
  memberIds: string[];
}

export interface Invitation {
  id: string;
  token: string;
  projectId: string;
  email: string;
  role: TeamShareRole;
  status: InvitationStatus;
  expiresAt: number;
}

/** Invitation view safe for listing UIs — omits the single-use bearer `token`,
 * which is only ever returned once, directly to the inviter, at creation time. */
export type InvitationSummary = Omit<Invitation, 'token'>;

export interface VerifiedEmailLookup {
  getVerifiedEmail(accountId: string): string | null;
}

export type AcceptInvitationResult =
  | { status: 'ok'; projectId: string; role: TeamShareRole }
  | { status: 'rejected' };

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class TeamAuthorizationDeniedError extends Error {
  constructor(action: string) {
    super(`Team authorization denied for action: ${action}`);
  }
}

export class LastOwnerProtectionError extends Error {
  constructor() {
    super('Action rejected: would leave the project without an owner');
  }
}

export class InvalidRoleGrantError extends Error {
  constructor(role: string) {
    super(`Role '${role}' cannot be granted through this operation`);
  }
}

/**
 * @id CODE-AIRA2-TEAM-001
 * @implements REQ-MULTIUSER-013 REQ-MULTIUSER-014 REQ-MULTIUSER-015 REQ-MULTIUSER-016
 *   REQ-MULTIUSER-017 REQ-MULTIUSER-025 REQ-MULTIUSER-026 REQ-MULTIUSER-029
 *   REQ-MULTIUSER-030 REQ-MULTIUSER-031 REQ-MULTIUSER-039 REQ-MULTIUSER-045
 * @design DES-AIRA2-013
 */
export class TeamService {
  private readonly teams = new Map<string, Team>();
  private readonly teamShares = new Map<string, Map<string, TeamShareRole>>(); // projectId -> teamId -> role
  private readonly invitations = new Map<string, Invitation>(); // token -> invitation

  constructor(
    private readonly projectAuthz: ProjectAuthorizationService,
    private readonly emails: VerifiedEmailLookup,
    private readonly audit: AuditLog = new AuditLog(),
  ) {}

  // ---- Teams (REQ-016, REQ-030) ----

  createTeam(actor: SelfScopeActorContext, name: string): Team {
    if (!authorizeSelf(actor, 'team.create')) {
      throw new TeamAuthorizationDeniedError('team.create');
    }
    const team: Team = { id: randomBytes(8).toString('hex'), name, adminUserId: actor.accountId, memberIds: [] };
    this.teams.set(team.id, team);
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'team.create',
      targetResource: `team:${team.id}`,
    });
    return team;
  }

  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  assignTeamAdmin(actor: SelfScopeActorContext, teamId: string, newAdminUserId: string): void {
    const team = this.requireTeam(teamId);
    this.requireTeamAdmin(actor, team, 'team.admin.modify');
    team.adminUserId = newAdminUserId;
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'team.admin.assign',
      targetResource: `team:${teamId}:user:${newAdminUserId}`,
    });
  }

  deleteTeam(actor: SelfScopeActorContext, teamId: string): void {
    const team = this.requireTeam(teamId);
    this.requireTeamAdmin(actor, team, 'team.delete');
    const affectedMembers = [...team.memberIds];
    this.teams.delete(teamId);
    for (const [projectId, shares] of this.teamShares.entries()) {
      if (shares.delete(teamId)) {
        for (const memberId of affectedMembers) {
          this.recomputeAndMaybeTerminate(projectId, memberId);
        }
      }
    }
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'team.delete',
      targetResource: `team:${teamId}`,
    });
  }

  addTeamMember(actor: SelfScopeActorContext, teamId: string, userId: string): void {
    const team = this.requireTeam(teamId);
    this.requireTeamAdmin(actor, team, 'team.membership.modify');
    if (!team.memberIds.includes(userId)) {
      team.memberIds.push(userId);
    }
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'team.member.add',
      targetResource: `team:${teamId}:user:${userId}`,
    });
  }

  removeTeamMember(actor: SelfScopeActorContext, teamId: string, userId: string): void {
    const team = this.requireTeam(teamId);
    this.requireTeamAdmin(actor, team, 'team.membership.modify');
    team.memberIds = team.memberIds.filter((id) => id !== userId);
    for (const [projectId, shares] of this.teamShares.entries()) {
      if (shares.has(teamId)) {
        this.recomputeAndMaybeTerminate(projectId, userId);
      }
    }
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'team.member.remove',
      targetResource: `team:${teamId}:user:${userId}`,
    });
  }

  private requireTeam(teamId: string): Team {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`unknown team: ${teamId}`);
    }
    return team;
  }

  private requireTeamAdmin(actor: SelfScopeActorContext, team: Team, action: string): void {
    if (!actor.isGlobalAdmin && actor.accountId !== team.adminUserId) {
      throw new TeamAuthorizationDeniedError(action);
    }
  }

  // ---- Team-based project sharing (REQ-017, REQ-026, REQ-031) ----

  grantTeamShare(actor: ActorContext, projectId: string, teamId: string, role: TeamShareRole): void {
    if (!this.projectAuthz.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    if ((role as string) === 'owner') {
      throw new InvalidRoleGrantError('owner');
    }
    this.requireTeam(teamId);
    let shares = this.teamShares.get(projectId);
    if (!shares) {
      shares = new Map();
      this.teamShares.set(projectId, shares);
    }
    shares.set(teamId, role);
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'team.share.grant',
      targetResource: `project:${projectId}:team:${teamId}`,
    });
  }

  revokeTeamShare(actor: ActorContext, projectId: string, teamId: string): void {
    if (!this.projectAuthz.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    const shares = this.teamShares.get(projectId);
    const team = this.teams.get(teamId);
    shares?.delete(teamId);
    if (team) {
      for (const memberId of team.memberIds) {
        this.recomputeAndMaybeTerminate(projectId, memberId);
      }
    }
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'team.share.revoke',
      targetResource: `project:${projectId}:team:${teamId}`,
    });
  }

  /**
   * Team-derived role only (ignoring owner/direct-share) — consumed by
   * `ProjectAuthorizationService.getRole` via `setTeamShareResolver` so every
   * project-authorization decision (not only `resolveEffectiveRole`'s own
   * callers) honors team-based grants (REQ-MULTIUSER-017/031). Deliberately
   * does not call back into `projectAuthz` to avoid a resolution cycle.
   */
  resolveTeamOnlyRole(userId: string, projectId: string): TeamShareRole | 'none' {
    const shares = this.teamShares.get(projectId);
    if (!shares) return 'none';
    let best: TeamShareRole | 'none' = 'none';
    for (const [teamId, role] of shares.entries()) {
      const team = this.teams.get(teamId);
      if (team && team.memberIds.includes(userId)) {
        if (role === 'editor') best = 'editor';
        if (role === 'viewer' && best === 'none') best = 'viewer';
      }
    }
    return best;
  }

  resolveEffectiveRole(userId: string, projectId: string): EffectiveRole {
    const directRole = this.projectAuthz.getRole(projectId, userId);
    if (directRole === 'owner') return 'owner';
    let best: EffectiveRole = (directRole as EffectiveRole) ?? 'none';
    const shares = this.teamShares.get(projectId);
    if (shares) {
      for (const [teamId, role] of shares.entries()) {
        const team = this.teams.get(teamId);
        if (team && team.memberIds.includes(userId)) {
          if (role === 'editor' && best !== 'editor') best = 'editor';
          if (role === 'viewer' && best === 'none') best = 'viewer';
        }
      }
    }
    return best;
  }

  private recomputeAndMaybeTerminate(projectId: string, userId: string): void {
    const role = this.resolveEffectiveRole(userId, projectId);
    if (role === 'none') {
      this.projectAuthz.terminateForRevokedAccess(projectId, userId);
    }
  }

  // ---- Invitations (REQ-013, REQ-014, REQ-025, REQ-039, REQ-045) ----

  createInvitation(actor: ActorContext, projectId: string, email: string, role: TeamShareRole): Invitation {
    if (!this.projectAuthz.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    if ((role as string) === 'owner') {
      throw new InvalidRoleGrantError('owner');
    }
    const invitation: Invitation = {
      id: randomBytes(8).toString('hex'),
      token: randomBytes(24).toString('hex'),
      projectId,
      email,
      role,
      status: 'pending',
      expiresAt: Date.now() + INVITATION_TTL_MS,
    };
    this.invitations.set(invitation.token, invitation);
    this.audit.record({
      userId: actor.accountId,
      timestamp: Date.now(),
      actionType: 'invitation.create',
      targetResource: `project:${projectId}:invitation:${invitation.id}`,
    });
    return invitation;
  }

  cancelInvitation(actor: ActorContext, projectId: string, invitationId: string): void {
    if (!this.projectAuthz.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    for (const invitation of this.invitations.values()) {
      if (invitation.projectId === projectId && invitation.id === invitationId && invitation.status === 'pending') {
        invitation.status = 'cancelled';
        this.audit.record({
          userId: actor.accountId,
          timestamp: Date.now(),
          actionType: 'invitation.cancel',
          targetResource: `project:${projectId}:invitation:${invitationId}`,
        });
      }
    }
  }

  /** Single atomic operation: pending check, target-email match, role grant, consumption (REQ-039). */
  acceptInvitation(token: string, accountId: string, now: number = Date.now()): AcceptInvitationResult {
    const invitation = this.invitations.get(token);
    if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= now) {
      return { status: 'rejected' };
    }
    const verifiedEmail = this.emails.getVerifiedEmail(accountId);
    if (!verifiedEmail || verifiedEmail !== invitation.email) {
      return { status: 'rejected' };
    }
    invitation.status = 'accepted';
    this.projectAuthz.grantShareViaInvitation(invitation.projectId, accountId, invitation.role);
    this.audit.record({
      userId: accountId,
      timestamp: now,
      actionType: 'invitation.accept',
      targetResource: `project:${invitation.projectId}:invitation:${invitation.id}`,
    });
    return { status: 'ok', projectId: invitation.projectId, role: invitation.role };
  }

  listInvitations(projectId: string): readonly Invitation[] {
    return [...this.invitations.values()].filter((i) => i.projectId === projectId);
  }

  // ---- Member management UI backing (REQ-015, REQ-029) ----

  listMembers(actor: ActorContext, projectId: string): {
    members: { userId: string; role: string }[];
    pendingInvitations: InvitationSummary[];
  } {
    if (!this.projectAuthz.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    const members = this.projectAuthz.listMemberRoles(projectId);
    const pendingInvitations = this.listInvitations(projectId)
      .filter((i) => i.status === 'pending')
      .map(({ token: _token, ...summary }) => summary);
    return { members, pendingInvitations };
  }

  changeMemberRole(actor: ActorContext, projectId: string, userId: string, role: TeamShareRole): void {
    if (!this.projectAuthz.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    if ((role as string) === 'owner') {
      throw new InvalidRoleGrantError('owner');
    }
    if (this.projectAuthz.getProjectOwner(projectId) === userId) {
      throw new LastOwnerProtectionError();
    }
    this.projectAuthz.grantShare(actor, projectId, userId, role);
  }

  removeMember(actor: ActorContext, projectId: string, userId: string): void {
    if (!this.projectAuthz.authorize(actor, projectId, 'project.share.manage')) {
      throw new AuthorizationDeniedError('project.share.manage');
    }
    if (this.projectAuthz.getProjectOwner(projectId) === userId) {
      throw new LastOwnerProtectionError();
    }
    this.projectAuthz.revokeShare(actor, projectId, userId);
  }
}

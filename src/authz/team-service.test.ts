import { describe, expect, it, vi } from 'vitest';
import { AuditLog } from './audit.js';
import { AuthorizationDeniedError, ProjectAuthorizationService, type RevocationNotifier } from './project-authz.js';
import { LastOwnerProtectionError, TeamAuthorizationDeniedError, TeamService, InvalidRoleGrantError, type VerifiedEmailLookup } from './team-service.js';

function makeService() {
  const audit = new AuditLog();
  const notifier: RevocationNotifier = { terminateSessionsAndConnections: vi.fn() };
  const projectAuthz = new ProjectAuthorizationService(audit, notifier);
  const verifiedEmails = new Map<string, string>();
  const emails: VerifiedEmailLookup = {
    getVerifiedEmail: (accountId) => verifiedEmails.get(accountId) ?? null,
  };
  const teams = new TeamService(projectAuthz, emails, audit);
  projectAuthz.setTeamShareResolver({
    resolveTeamOnlyRole: (userId, projectId) => teams.resolveTeamOnlyRole(userId, projectId),
  });
  return { audit, notifier, projectAuthz, verifiedEmails, teams };
}

const GLOBAL_ADMIN = { accountId: 'root-admin', isGlobalAdmin: true };
const PLAIN_MEMBER = { accountId: 'plain-member', isGlobalAdmin: false };

/** @id TEST-AIRA2-TEAM-001
 * @verifies REQ-MULTIUSER-013
 */
describe('project member invitation by email', () => {
  it('TEST-AIRA2-TEAM-001 creates a pending invitation without granting access, and rejects an owner-role invitation', () => {
    const { teams, projectAuthz } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');

    const invitation = teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'newperson@example.com', 'editor');

    expect(invitation.status).toBe('pending');
    expect(projectAuthz.authorize({ accountId: 'newperson@example.com' }, 'project-1', 'eln.view')).toBe(false);
    expect(() =>
      teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'x@example.com', 'owner' as never),
    ).toThrow(InvalidRoleGrantError);
  });
});

/** @id TEST-AIRA2-TEAM-002
 * @verifies REQ-MULTIUSER-014
 */
describe('invitation acceptance grants role', () => {
  it('TEST-AIRA2-TEAM-002 grants the invited role and consumes the invitation only for the matching verified email', () => {
    const { teams, projectAuthz, verifiedEmails } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    const invitation = teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'invitee@example.com', 'editor');

    verifiedEmails.set('mismatched-user', 'someone-else@example.com');
    const mismatched = teams.acceptInvitation(invitation.token, 'mismatched-user');
    expect(mismatched).toEqual({ status: 'rejected' });

    verifiedEmails.set('invitee-account', 'invitee@example.com');
    const accepted = teams.acceptInvitation(invitation.token, 'invitee-account');

    expect(accepted).toEqual({ status: 'ok', projectId: 'project-1', role: 'editor' });
    expect(projectAuthz.getRole('project-1', 'invitee-account')).toBe('editor');
    expect(teams.listInvitations('project-1').find((i) => i.id === invitation.id)?.status).toBe('accepted');
  });
});

/** @id TEST-AIRA2-TEAM-003
 * @verifies REQ-MULTIUSER-015
 */
describe('project member management UI', () => {
  it('TEST-AIRA2-TEAM-003 lists members and pending invitations, and rejects a non-authorized caller', () => {
    const { teams, projectAuthz } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    projectAuthz.grantShare({ accountId: 'owner-1' }, 'project-1', 'editor-1', 'editor');
    teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'pending@example.com', 'viewer');

    const listing = teams.listMembers({ accountId: 'owner-1' }, 'project-1');
    expect(listing.members).toEqual(expect.arrayContaining([{ userId: 'owner-1', role: 'owner' }, { userId: 'editor-1', role: 'editor' }]));
    expect(listing.pendingInvitations).toHaveLength(1);

    expect(() => teams.listMembers({ accountId: 'editor-1' }, 'project-1')).toThrow(AuthorizationDeniedError);
  });

  /** @id TEST-AIRA2-TEAM-014
   * @verifies REQ-MULTIUSER-015
   */
  it('TEST-AIRA2-TEAM-014 never exposes an invitation bearer token through the member/invitation listing', () => {
    const { teams, projectAuthz } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'pending@example.com', 'viewer');

    const listing = teams.listMembers({ accountId: 'owner-1' }, 'project-1');
    expect(listing.pendingInvitations).toHaveLength(1);
    expect(listing.pendingInvitations[0]).not.toHaveProperty('token');
    expect(JSON.stringify(listing.pendingInvitations)).not.toContain('token');
  });
});

/** @id TEST-AIRA2-TEAM-004
 * @verifies REQ-MULTIUSER-016
 */
describe('team entity for grouped access', () => {
  it('TEST-AIRA2-TEAM-004 creates a team and lets only the team admin change its membership', () => {
    const { teams } = makeService();
    const team = teams.createTeam(GLOBAL_ADMIN, 'Lab Team');
    expect(team.adminUserId).toBe(GLOBAL_ADMIN.accountId);

    teams.addTeamMember(GLOBAL_ADMIN, team.id, 'member-1');
    expect(teams.getTeam(team.id)?.memberIds).toContain('member-1');

    expect(() => teams.addTeamMember(PLAIN_MEMBER, team.id, 'member-2')).toThrow(TeamAuthorizationDeniedError);

    teams.removeTeamMember(GLOBAL_ADMIN, team.id, 'member-1');
    expect(teams.getTeam(team.id)?.memberIds).not.toContain('member-1');
  });
});

/** @id TEST-AIRA2-TEAM-005
 * @verifies REQ-MULTIUSER-017
 */
describe('team-based project sharing', () => {
  it('TEST-AIRA2-TEAM-005 grants team members project access, extends to newly added members, and rejects owner grants', () => {
    const { teams, projectAuthz } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    const team = teams.createTeam(GLOBAL_ADMIN, 'Lab Team');
    teams.addTeamMember(GLOBAL_ADMIN, team.id, 'member-1');

    teams.grantTeamShare({ accountId: 'owner-1' }, 'project-1', team.id, 'editor');
    expect(teams.resolveEffectiveRole('member-1', 'project-1')).toBe('editor');

    teams.addTeamMember(GLOBAL_ADMIN, team.id, 'member-2');
    expect(teams.resolveEffectiveRole('member-2', 'project-1')).toBe('editor');

    expect(() => teams.grantTeamShare({ accountId: 'owner-1' }, 'project-1', team.id, 'owner' as never)).toThrow(
      InvalidRoleGrantError,
    );
  });
});

/** @id TEST-AIRA2-TEAM-006
 * @verifies REQ-MULTIUSER-025
 */
describe('invitation acceptance rejection', () => {
  it('TEST-AIRA2-TEAM-006 rejects acceptance for expired, consumed, cancelled, or unknown tokens with no role granted', () => {
    const { teams, projectAuthz, verifiedEmails } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    verifiedEmails.set('user-a', 'a@example.com');

    const expired = teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'a@example.com', 'viewer');
    expect(teams.acceptInvitation(expired.token, 'user-a', expired.expiresAt + 1)).toEqual({ status: 'rejected' });

    const consumed = teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'a@example.com', 'viewer');
    teams.acceptInvitation(consumed.token, 'user-a');
    expect(teams.acceptInvitation(consumed.token, 'user-a')).toEqual({ status: 'rejected' });

    const cancelled = teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'a@example.com', 'viewer');
    teams.cancelInvitation({ accountId: 'owner-1' }, 'project-1', cancelled.id);
    expect(teams.acceptInvitation(cancelled.token, 'user-a')).toEqual({ status: 'rejected' });

    expect(teams.acceptInvitation('unknown-token', 'user-a')).toEqual({ status: 'rejected' });
  });
});

/** @id TEST-AIRA2-TEAM-007
 * @verifies REQ-MULTIUSER-026
 */
describe('team removal revokes team-based access', () => {
  it('TEST-AIRA2-TEAM-007 terminates access derived solely from a removed team, but preserves access backed by another grant', () => {
    const { teams, projectAuthz, notifier } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    const team = teams.createTeam(GLOBAL_ADMIN, 'Lab Team');
    teams.addTeamMember(GLOBAL_ADMIN, team.id, 'solely-team-based');
    teams.addTeamMember(GLOBAL_ADMIN, team.id, 'also-direct-share');
    teams.grantTeamShare({ accountId: 'owner-1' }, 'project-1', team.id, 'editor');
    projectAuthz.grantShare({ accountId: 'owner-1' }, 'project-1', 'also-direct-share', 'viewer');

    teams.removeTeamMember(GLOBAL_ADMIN, team.id, 'solely-team-based');
    teams.removeTeamMember(GLOBAL_ADMIN, team.id, 'also-direct-share');

    expect(notifier.terminateSessionsAndConnections).toHaveBeenCalledWith('project-1', 'solely-team-based');
    expect(notifier.terminateSessionsAndConnections).not.toHaveBeenCalledWith('project-1', 'also-direct-share');
    expect(teams.resolveEffectiveRole('also-direct-share', 'project-1')).toBe('viewer');
  });
});

/** @id TEST-AIRA2-TEAM-008
 * @verifies REQ-MULTIUSER-029
 */
describe('last owner protection', () => {
  it('TEST-AIRA2-TEAM-008 rejects removing or demoting the sole owner, but allows other members to be removed', () => {
    const { teams, projectAuthz } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    projectAuthz.grantShare({ accountId: 'owner-1' }, 'project-1', 'member-1', 'editor');

    expect(() => teams.removeMember({ accountId: 'owner-1' }, 'project-1', 'owner-1')).toThrow(LastOwnerProtectionError);
    expect(() => teams.changeMemberRole({ accountId: 'owner-1' }, 'project-1', 'owner-1', 'viewer')).toThrow(
      LastOwnerProtectionError,
    );

    expect(() => teams.removeMember({ accountId: 'owner-1' }, 'project-1', 'member-1')).not.toThrow();
  });
});

/** @id TEST-AIRA2-TEAM-009
 * @verifies REQ-MULTIUSER-030
 */
describe('team administration authorization', () => {
  it('TEST-AIRA2-TEAM-009 restricts team creation and admin/delete actions to a global admin or the team\'s own admin', () => {
    const { teams } = makeService();
    expect(() => teams.createTeam(PLAIN_MEMBER, 'Should Fail')).toThrow(TeamAuthorizationDeniedError);

    const team = teams.createTeam(GLOBAL_ADMIN, 'Lab Team');
    expect(() => teams.assignTeamAdmin(PLAIN_MEMBER, team.id, 'new-admin')).toThrow(TeamAuthorizationDeniedError);
    teams.assignTeamAdmin(GLOBAL_ADMIN, team.id, 'new-admin');
    expect(teams.getTeam(team.id)?.adminUserId).toBe('new-admin');

    teams.assignTeamAdmin({ accountId: 'new-admin', isGlobalAdmin: false }, team.id, 'new-admin');
    expect(() => teams.deleteTeam(PLAIN_MEMBER, team.id)).toThrow(TeamAuthorizationDeniedError);
    expect(() => teams.deleteTeam({ accountId: 'new-admin', isGlobalAdmin: false }, team.id)).not.toThrow();
  });
});

/** @id TEST-AIRA2-TEAM-010
 * @verifies REQ-MULTIUSER-031
 */
describe('effective project role resolution', () => {
  it('TEST-AIRA2-TEAM-010 resolves the most-permissive role among owner, direct share, and team share', () => {
    const { teams, projectAuthz } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    projectAuthz.grantShare({ accountId: 'owner-1' }, 'project-1', 'user-1', 'viewer');
    const team = teams.createTeam(GLOBAL_ADMIN, 'Lab Team');
    teams.addTeamMember(GLOBAL_ADMIN, team.id, 'user-1');
    teams.grantTeamShare({ accountId: 'owner-1' }, 'project-1', team.id, 'editor');

    expect(teams.resolveEffectiveRole('user-1', 'project-1')).toBe('editor');

    teams.revokeTeamShare({ accountId: 'owner-1' }, 'project-1', team.id);
    expect(teams.resolveEffectiveRole('user-1', 'project-1')).toBe('viewer');
  });
});

/** @id TEST-AIRA2-TEAM-013
 * @verifies REQ-MULTIUSER-017 REQ-MULTIUSER-031
 */
describe('project authorization honors team-based shares', () => {
  it('TEST-AIRA2-TEAM-013 grants and revokes real project.authorize() decisions through team membership alone, with no direct share', () => {
    const { teams, projectAuthz } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    const team = teams.createTeam(GLOBAL_ADMIN, 'Lab Team');
    teams.addTeamMember(GLOBAL_ADMIN, team.id, 'member-1');

    expect(projectAuthz.authorize({ accountId: 'member-1' }, 'project-1', 'eln.view')).toBe(false);

    teams.grantTeamShare({ accountId: 'owner-1' }, 'project-1', team.id, 'editor');
    expect(projectAuthz.authorize({ accountId: 'member-1' }, 'project-1', 'eln.view')).toBe(true);
    expect(projectAuthz.authorize({ accountId: 'member-1' }, 'project-1', 'eln.create')).toBe(true);

    teams.revokeTeamShare({ accountId: 'owner-1' }, 'project-1', team.id);
    expect(projectAuthz.authorize({ accountId: 'member-1' }, 'project-1', 'eln.view')).toBe(false);
  });
});


/** @id TEST-AIRA2-TEAM-011
 * @verifies REQ-MULTIUSER-039
 */
describe('atomic invitation acceptance', () => {
  it('TEST-AIRA2-TEAM-011 lets exactly one of two acceptance attempts for the same token succeed', () => {
    const { teams, projectAuthz, verifiedEmails } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    verifiedEmails.set('user-1', 'a@example.com');
    const invitation = teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'a@example.com', 'editor');

    const first = teams.acceptInvitation(invitation.token, 'user-1');
    const second = teams.acceptInvitation(invitation.token, 'user-1');

    expect(first).toEqual({ status: 'ok', projectId: 'project-1', role: 'editor' });
    expect(second).toEqual({ status: 'rejected' });
    expect(projectAuthz.getRole('project-1', 'user-1')).toBe('editor');
  });
});

/** @id TEST-AIRA2-TEAM-012
 * @verifies REQ-MULTIUSER-045
 */
describe('invitation matching restricted to verified email', () => {
  it('TEST-AIRA2-TEAM-012 rejects a match against an email that is not the account\'s currently verified email', () => {
    const { teams, projectAuthz, verifiedEmails } = makeService();
    projectAuthz.createProject('owner-1', 'project-1');
    const invitation = teams.createInvitation({ accountId: 'owner-1' }, 'project-1', 'unverified@example.com', 'viewer');

    // Account exists but has not verified this email address (no entry / a different verified email).
    verifiedEmails.set('user-1', 'other-verified@example.com');
    expect(teams.acceptInvitation(invitation.token, 'user-1')).toEqual({ status: 'rejected' });
    expect(projectAuthz.getRole('project-1', 'user-1')).toBeUndefined();
  });
});

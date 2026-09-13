# CHANGE-0005: Audit log coverage for CHANGE-0004 self-service and team mutations / CHANGE-0004自己サービス・チーム操作の監査ログ補完

Feature: aira2-platform
Classification: defect-correction

## Summary / 概要

CHANGE-0004 explicitly noted that REQ-MULTIUSER-006 ("audit entry for every
authentication, authorization, project-sharing, and administrative
configuration event") already applies to every event it introduced
(invitations, team administration, password change/reset, MFA
enrollment/verification, session revocation), but its implementation did
not fully satisfy that obligation: `AccountSelfService` records zero audit
entries, and several `TeamService` mutations (team CRUD, team-share
grant/revoke, invitation accept/cancel, member role change/removal) are
also missing audit entries. Only `project.share.grant`,
`project.share.grant-via-invitation`, `project.share.revoke` (in
`ProjectAuthorizationService`) and `invitation.create` (in `TeamService`)
are currently recorded.

This CHANGE is a defect correction against the existing, unchanged
REQ-MULTIUSER-006. No requirement text and no design text change is
needed: the acceptance criterion ("every ... event" produces an audit
entry) was already correct; the implementation simply did not yet satisfy
it for the events CHANGE-0004 added. This CHANGE closes that gap by
wiring the existing `AuditLog` (`src/authz/audit.ts`, `CODE-AIRA2-AUTHZ-003`)
into `AccountSelfService` and the remaining `TeamService` mutations,
following the exact pattern already used in `ProjectAuthorizationService`.

## Requirements / 要求

Requirements: REQ-MULTIUSER-006 (existing; no text change)

## Scope / 範囲

In scope — add an `audit.record(...)` call, following the existing
`{ userId, timestamp, actionType, targetResource }` shape, immediately
after each of the following mutations succeeds (never including a raw
password, TOTP code/secret, or invitation/reset token in `targetResource`):

- `AccountSelfService.updateProfile` → `profile.update`
- `AccountSelfService.confirmEmailChange` → `profile.email.confirm`
- `AccountSelfService.changePassword` → `auth.password.change`
- `AccountSelfService.requestPasswordReset` → `auth.password.reset-request`
  (only when a matching account exists, so the request's externally
  observable behavior — always `{status:'ok'}` — is unchanged)
- `AccountSelfService.completePasswordReset` → `auth.password.reset-complete`
- `AccountSelfService.enrollTotp` → `mfa.enroll`
- `AccountSelfService.confirmTotpEnrollment` → `mfa.confirm` (only when the
  code is valid and enrollment is actually confirmed)
- Self-service session revocation (`DELETE /users/me/sessions/:displayId`
  in `src/server/app.ts`, backed by `SessionRegistry.revokeSession`) →
  `session.revoke` (only when a session was actually revoked)
- `TeamService.createTeam` → `team.create`
- `TeamService.assignTeamAdmin` → `team.admin.assign`
- `TeamService.deleteTeam` → `team.delete`
- `TeamService.addTeamMember` → `team.member.add`
- `TeamService.removeTeamMember` → `team.member.remove`
- `TeamService.grantTeamShare` → `team.share.grant`
- `TeamService.revokeTeamShare` → `team.share.revoke`
- `TeamService.cancelInvitation` → `invitation.cancel`
- `TeamService.acceptInvitation` → `invitation.accept` (only on success)

`TeamService.changeMemberRole` and `TeamService.removeMember` already delegate
to `ProjectAuthorizationService.grantShare`/`revokeShare`, which already
record `project.share.grant`/`project.share.revoke`; no additional audit
call is needed there — a test confirming that existing coverage is enough.

`AccountSelfService` gains an optional `audit: AuditLog = new AuditLog()`
constructor parameter (mirroring `TeamService`'s existing pattern);
`src/server/app.ts`'s `buildContext()` passes the same shared,
store-backed `audit` instance used by `ProjectAuthorizationService` and
`TeamService`, and exposes it on `AppContext` so the session-revoke route
handler can record its own entry.

Out of scope (deferred to separate future CHANGEs, per explicit user
decision):
- Deployment-wide MFA enforcement (REQ-MULTIUSER-022) — currently
  unimplemented; tracked as a separate residual risk.
- Durable persistence for TOTP/session/profile/reset-tokens/rate-limits
  (currently process-memory only) — requires new requirements, since
  in-memory storage was a prior accepted design decision, not a violated
  requirement; tracked as a separate residual risk.
- Audit coverage for pre-existing login/authentication flows from
  CHANGE-0001/0003 (`src/auth/login.ts`) — out of scope; this CHANGE only
  closes the gap for events CHANGE-0004 itself introduced.

## Acceptance criteria / 受入基準

- For each mutation listed above, a unit/integration test proves that a
  successful call appends exactly one matching `AuditLog` entry (correct
  `actionType`, a `targetResource` containing no secret material, and a
  `userId` identifying the acting/affected account).
- Failure paths (invalid token, wrong password, invalid TOTP code, etc.)
  do not record a misleading success-shaped audit entry.
- `npx musubix3 gate --changed --json` shows no new failing checks beyond
  the pre-existing, permanently-blocked `workflow` / `change-history` /
  `change-completeness` / `approval` checks already documented for
  CHANGE-0001/0004.

## Deferred follow-ups / 今後の課題

Two rubber-duck review passes (post-implementation and post-fix) found
**zero blocking issues**. The following non-blocking suggestions surfaced
are explicitly deferred as out of scope for this defect-fix CHANGE (they
would expand scope beyond "add the missing audit entries" into new
behavioral/design questions) and should be considered for a future CHANGE:

- Whether an expired (but validly-issued) password-reset token should get
  its own dedicated test assertion distinct from an unknown/invalid token
  (`TEST-AIRA2-AUDIT-009`).
- Whether no-op self-service/team calls (e.g. adding an already-present
  member, granting an identical share, submitting an empty profile patch)
  should be excluded from audit recording, or whether "authorized attempt"
  is the intended semantic and should be documented/named as such.
- Adding explicit before/after audit-count assertions around invitation
  failure paths (expired/consumed/cancelled/mismatched-email acceptance;
  cancellation of a non-pending/unknown invitation) in
  `TEST-AIRA2-AUDIT-014`.

## Source references / 参照元

- CHANGE-0004 (`.musubix/changes/CHANGE-0004.md`) — the change whose
  events this CHANGE now fully audits.
- `src/authz/project-authz.ts` — the existing, followed audit pattern
  (`grantShare`/`grantShareViaInvitation`/`revokeShare`).
- `src/authz/audit.ts` (`CODE-AIRA2-AUTHZ-003`) — the `AuditLog` class
  reused by this CHANGE, not reinvented.

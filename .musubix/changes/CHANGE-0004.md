# CHANGE-0004: Multi-user feature extension (invitations, teams, profile, password reset, MFA, session management) / マルチユーザー機能拡張

Feature: aira2-platform
Classification: feature

## Summary / 概要

CHANGE-0001/0002/0003 delivered the multi-user platform's core: pluggable
authentication methods, admin/member accounts, project-level owner/editor/
viewer roles with a documented and enforced authorization matrix, project
sharing/revocation, and a per-user audit log. This CHANGE extends that
foundation with the self-service and administrative capabilities needed for
real multi-user operation at scale: email-based project member invitation
and acceptance, a member-management UI, a team entity for grouped project
sharing, user profile self-service, self-service password change and
token-based password reset, TOTP multi-factor authentication (with an
optional deployment-wide enforcement setting), and self-service active
session listing/revocation.

## Requirements / 要求

Requirements: REQ-MULTIUSER-008, REQ-MULTIUSER-013, REQ-MULTIUSER-014, REQ-MULTIUSER-015, REQ-MULTIUSER-016, REQ-MULTIUSER-017, REQ-MULTIUSER-018, REQ-MULTIUSER-019, REQ-MULTIUSER-020, REQ-MULTIUSER-021, REQ-MULTIUSER-022, REQ-MULTIUSER-023, REQ-MULTIUSER-024, REQ-MULTIUSER-025, REQ-MULTIUSER-026, REQ-MULTIUSER-027, REQ-MULTIUSER-028, REQ-MULTIUSER-029, REQ-MULTIUSER-030, REQ-MULTIUSER-031, REQ-MULTIUSER-032, REQ-MULTIUSER-033, REQ-MULTIUSER-034, REQ-MULTIUSER-035, REQ-MULTIUSER-036, REQ-MULTIUSER-037, REQ-MULTIUSER-038, REQ-MULTIUSER-039, REQ-MULTIUSER-040, REQ-MULTIUSER-041, REQ-MULTIUSER-042, REQ-MULTIUSER-043, REQ-MULTIUSER-044, REQ-MULTIUSER-045, REQ-MULTIUSER-046, REQ-MULTIUSER-047, REQ-MULTIUSER-048, REQ-MULTIUSER-049, REQ-MULTIUSER-050

## Scope / 範囲

In scope:
- Project member invitation by email with pending/accepted/expired/consumed
  lifecycle (REQ-MULTIUSER-013/014).
- Member management UI: list members/invitations, change role, remove
  member, cancel invitation (REQ-MULTIUSER-015).
- Team entity (name + members, team-admin managed) and team-based project
  sharing that tracks live team membership (REQ-MULTIUSER-016/017).
- User profile self-service UI/API (display name, contact email only;
  role/account ID immutable via this path) (REQ-MULTIUSER-018).
- Self-service password change with current-password verification and
  other-session invalidation (REQ-MULTIUSER-019).
- Token-based password reset: single-use, time-limited, out-of-band
  delivery (REQ-MULTIUSER-020).
- TOTP MFA enrollment and verification at login, plus an optional
  deployment-wide MFA-required setting (REQ-MULTIUSER-021/022/033/034/035).
- Self-service active session listing and revocation of a non-current
  session (REQ-MULTIUSER-023/024).
- Last-owner protection, team-administration authorization, and effective
  multi-source project-role resolution (REQ-MULTIUSER-029/030/031).
- Password reset request rate limiting (REQ-MULTIUSER-036).
- Atomic invitation acceptance and atomic password-reset completion
  (REQ-MULTIUSER-039/043); verified-email lifecycle and uniqueness for
  invitation identity matching (REQ-MULTIUSER-040/041/042); TOTP replay
  rejection (REQ-MULTIUSER-044).
- REQ-MULTIUSER-008 (existing, from CHANGE-0001) is amended to add an
  explicit numeric bound (5 seconds) to its previously vague "bounded
  time" acceptance criterion, since REQ-MULTIUSER-026 (new, team-based
  revocation) needs a concrete, testable bound to reference. No other
  aspect of REQ-MULTIUSER-008's behavior changes.

Note: REQ-MULTIUSER-006 ("audit entry for every authentication,
authorization, project-sharing, and administrative configuration event")
already applies to every new event introduced here (invitations, team
administration, password change/reset, MFA enrollment/verification,
session revocation); no new requirement ID is added for this since
REQ-MULTIUSER-006's scope already covers it, but the design/implementation
and test evidence for this CHANGE must demonstrate that coverage
explicitly, and must never place a raw invitation/reset token, password,
TOTP code, or TOTP secret into an audit target/details field.

Out of scope (unchanged / not addressed by this CHANGE):
- LLM backend provider expansion (REQ-LLMBACKEND-*).
- Non-multi-user GUI areas.
- ELN functional scope beyond what REQ-MULTIUSER-011's existing
  authorization matrix already covers.
- Agent Skills/MCP parity, Graph RAG merge.
- SMS/hardware-key second factors (only TOTP is in scope).

## Source references / 参照元

- CHANGE-0001 (`.musubix/changes/CHANGE-0001.md`) for the original
  multi-user platform requirements (REQ-MULTIUSER-001..012) and
  authorization matrix this CHANGE extends.
- CHANGE-0003 (`.musubix/changes/CHANGE-0003.md`) for the runnable
  server/persistence/GUI substrate this CHANGE builds on.

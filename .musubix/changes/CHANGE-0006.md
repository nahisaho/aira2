# CHANGE-0006: Durable persistence for team, self-service, and session state / チーム・自己管理・セッション状態の永続化

Feature: aira2-platform
Classification: behavior-change

## Summary / 概要

DES-AIRA2-011 ("Runtime Server & Persistence") already commits, in its
Responsibilities, to giving "every existing component (DES-AIRA2-001..09)
a durable table/adapter behind its method signatures in place of its
previous in-memory `Map`". REQ-RUNTIME-002 requires durable persistence,
across a process restart, of user accounts/roles, LLM credentials/backend
selections, project membership/shares/audit log, ELN records, Agent
Skills/MCP configuration, and Graph RAG data.

CHANGE-0004 introduced three new components — DES-AIRA2-013 (Invitation &
Team Management Service), DES-AIRA2-014 (Account Profile, Password & MFA
Self-Service), and DES-AIRA2-015 (Session Registry & Credential
Versioning) — implemented as `TeamService`, `AccountSelfService`, and
`SessionRegistry`. All three were built with their own private in-memory
`Map` fields and were never wired to `SqliteStore`, and REQ-RUNTIME-002's
enumeration and DES-AIRA2-011's Responsibilities were never updated to
include them. As a result, restarting the server process silently
discards: every user's profile/verified-email/password
hash/pending-email-change/password-reset-token/TOTP-factor state; every
team, team-share grant, and pending/consumed invitation; and every active
session and credential version. This contradicts the durability guarantee
already implied for every other component and is a real operational
defect (a production restart or deploy logs every user out, deletes every
team, and forces password/MFA re-enrollment), but closing it requires
extending REQ-RUNTIME-002's statement/acceptance criteria to explicitly
name this newer state — hence a `behavior-change` classification (a
requirements-text change), not a pure `defect-correction`.

Per explicit user decision, active sessions are in scope for durable
persistence (not merely profile/team/invitation data): a restart must not
force re-login.

## Requirements / 要求

REQ-RUNTIME-002 (statement and acceptance criteria extended; ID preserved
because the underlying obligation — "durably persist, across a process
restart, all state required to preserve every existing requirement's
pre-restart behavior" — is unchanged; only the enumerated scope grows to
name components that did not exist when REQ-RUNTIME-002 was first
written).

## Scope / 範囲

### In scope
- `SqliteStore` (`src/server/store.ts`): add tables/methods needed to
  persist:
  - `TeamService` state: teams (id, name, adminUserId), team memberships,
    team-project shares (projectId/teamId/role), invitations (token,
    projectId, email, role, status, expiry).
  - `AccountSelfService` state: profile records (displayName, email,
    verifiedEmail), pending email changes (token, new email, expiry),
    password reset tokens (token, accountId, expiry, consumed) and their
    rate-limit log, TOTP factors (encrypted secret, activated flag,
    accepted time-steps, lockout state). Password hashes already have a
    store-backed table (`upsertPasswordCredential`/`getPasswordCredential`)
    that `AccountSelfService` does not yet use — this CHANGE wires it in.
  - `SessionRegistry` state: sessions (already has
    `upsertSession`/`getSession`/`deleteSession`, unused by
    `SessionRegistry` today; needs a new `listSessionsByAccount` query),
    per-account credential versions, and the session's opaque display ID.
- `TeamService`, `AccountSelfService`, `SessionRegistry`: accept a
  `SqliteStore` constructor dependency (mirroring every other
  DES-AIRA2-001..009 component) and read/write through it instead of a
  private `Map`, with no change to any existing public method signature
  or observable behavior for any already-passing test.
- `src/server/app.ts`: wire the shared `store` into all three
  constructors.
- `.musubix/features/aira2-platform/requirements.md`: extend
  REQ-RUNTIME-002's statement/acceptance to name team/invitation state,
  self-service profile/password/MFA state, and session/credential-version
  state.
- `.musubix/features/aira2-platform/design.md`: extend DES-AIRA2-011's
  Responsibilities to include DES-AIRA2-013/014/015 in its
  "every existing component" list; extend DES-AIRA2-013/014/015's own
  Interfaces text to note the store-backed constructor dependency (same
  pattern already used by DES-AIRA2-001..009).
- New restart-persistence tests: focused component-level tests proving
  each of the three components' state survives a fresh instance
  constructed against the same `SqliteStore`/database file (useful,
  fast-running unit coverage), plus at least one real full-server
  process stop/start integration test (per the Acceptance criteria below)
  proving the same for the actual deployed composition, not merely the
  isolated components.

### Out of scope
- Any change to a public *method's* signature, authorization rule, or
  observable success/failure behavior of `TeamService`, `AccountSelfService`,
  or `SessionRegistry` — this CHANGE is a storage-layer swap only. Each
  component's *constructor* does gain a `SqliteStore` dependency (an
  internal composition-root wiring concern, mirroring every
  DES-AIRA2-001..009 component's existing constructor pattern); this is not
  an externally observable API and is explicitly permitted by this CHANGE.
- Deployment-wide MFA enforcement (REQ-MULTIUSER-022) — deferred, tracked
  separately per the user's explicit prioritization.
- The three non-blocking CHANGE-0005 follow-ups (expired-token test
  granularity, no-op audit semantics, invitation failure-path test
  coverage) — unrelated to persistence, deferred separately.

## Acceptance criteria / 受入基準

- A test starts the actual server process against a file-backed database,
  creates through its normal interfaces a team with a team-based project
  share, a pending invitation, an accepted (consumed) invitation, a
  cancelled invitation, a self-service profile with a confirmed verified
  email and a pending email change, a password-reset token, an exhausted
  password-reset rate-limit window, an enrolled/activated MFA (TOTP)
  factor with an already-accepted time-step and a triggered lockout, and
  an active session; stops and restarts the server process against the
  same database (a real process restart, not merely a fresh in-memory
  instance); and confirms, through the normal REST/component interfaces,
  every one of REQ-RUNTIME-002's newly-extended acceptance conditions
  holds (see requirements.md for the full enumeration: consumed/cancelled
  invitations stay non-acceptable, verified email still governs
  matching/reset eligibility, rate-limit window still rejects, MFA replay
  still rejected and lockout still in effect, session still valid with
  correct credential version).
- All existing tests continue to pass unchanged (no behavior regression).
- `npx musubix3 gate --changed --json` shows no new failing checks beyond
  the pre-existing, permanently-blocked `workflow` / `change-history` /
  `change-completeness` / `approval` checks already documented for
  CHANGE-0001/0004/0005.

## Deferred follow-ups / 今後の課題

Two rubber-duck review passes were run against the implementation. The
first pass found three blocking single-process crash-consistency gaps,
all fixed before release:

- `enrollTotp()` now wraps deletion of prior TOTP replay history and
  persistence of the new factor in one `runInTransaction()` call, so a
  crash between the two steps can no longer leave stale replay history
  active against a newly generated secret.
- `confirmTotpEnrollment()`/`verifyCodeAgainstFactor()` now activate the
  factor inside the same transaction that records the accepted step,
  instead of persisting activation in a separate call afterward.
- `store.ts` gained `deleteExpiredResetRequests()`, called from
  `requestPasswordReset()`, to bound `reset_request_log` growth; `hydrate()`
  also skips loading expired rows into the in-memory rate-limit bucket.

The second rubber-duck pass found zero remaining blocking issues. The
following are explicitly out of scope for this CHANGE (REQ-RUNTIME-002 is
a single-process restart-durability guarantee, not a multi-instance/
horizontal-scaling guarantee) and are deferred to a future CHANGE if
multi-instance deployment is ever required:

- TOTP replay/lockout state is authoritative per-process (in-memory Maps
  checked before the DB write); two independently hydrated processes
  sharing one database could both accept the same code or miss a
  lockout written by the other.
- `profiles.verified_email` has no DB-level unique constraint; uniqueness
  is currently enforced only by scanning the in-memory map, which is not
  safe across independent concurrent processes.
- One non-blocking suggestion (wrapping `recordResetRequest` +
  `deleteExpiredResetRequests` in one transaction for stricter durable
  size-bounding) was not applied since a crash in that narrow window does
  not affect rate-limit correctness, only table size.

## Source references / 参照元

- `.musubix/features/aira2-platform/requirements.md` — REQ-RUNTIME-002
- `.musubix/features/aira2-platform/design.md` — DES-AIRA2-011,
  DES-AIRA2-013, DES-AIRA2-014, DES-AIRA2-015
- `src/server/store.ts`, `src/authz/team-service.ts`,
  `src/auth/account-self-service.ts`, `src/auth/session-registry.ts`,
  `src/server/app.ts`

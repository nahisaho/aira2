# CHANGE-0003: Runnable server, persistence, and real-rendering GUI / 起動可能サーバー・永続化・実描画GUI

Feature: aira2-platform
Classification: feature

## Summary / 概要

CHANGE-0001 delivered all AIRA2 platform logic (auth, LLM backends, ELN,
Graph RAG, authorization, GUI contracts) as in-process TypeScript modules
under a "minimal-contract" GUI design, with no runnable server and no
persistent storage. This CHANGE adds: a startable Node.js HTTP server
exposing a REST API, a SQLite-backed persistence layer so data survives a
process restart, and a React (Vite) single-page application that actually
renders six GUI areas (authentication, LLM settings, ELN, Graph RAG,
projects, chat) in a browser by calling the REST API, replacing the prior
non-rendering minimal-contract UI as the deployed interface. It also adds
REQ-RUNTIME-011 defining chat/agent execution, which was previously named
only as a styling target in REQ-GUI-005 with no functional requirement of
its own.

Requirements: REQ-RUNTIME-001 REQ-RUNTIME-002 REQ-RUNTIME-003 REQ-RUNTIME-004 REQ-RUNTIME-005 REQ-RUNTIME-006 REQ-RUNTIME-007 REQ-RUNTIME-008 REQ-RUNTIME-009 REQ-RUNTIME-010 REQ-RUNTIME-011

## Scope of this change / このChangeのスコープ

- New: REQ-RUNTIME-001..011 (server startup, health check, durable
  full-state persistence across restarts including the multi-user audit
  log, a REST API covering Agent Skills/MCP configuration and chat plus
  its authorization enforcement, a React SPA replacing the minimal-contract
  UI for all six GUI areas, environment-based configuration, and
  bootstrap-only shared-credential precedence rules that never overwrite
  an administrator-set value).
- Not modified: REQ-GUI-001..005 statements/acceptance are unchanged; their
  observable behavior is now backed by a real REST API and rendered SPA
  instead of an in-process minimal-contract controller, which is an
  implementation change, not a requirement change.
- Not modified: REQ-MULTIUSER-*, REQ-LLMBACKEND-*, REQ-ELN-*, REQ-GRAPHRAG-*,
  REQ-AGENTCONFIG-* statements are unchanged; REQ-RUNTIME-002/003 explicitly
  reference which of their state/actions must be durably persisted and
  exposed over REST, respectively.

All REQ-RUNTIME-001..011 requirements are implemented, unit-tested (TDD
Red/Green recorded per test/requirement pair), and traced
(`trace check --strict`: 0 diagnostics). Full test suite (23 files / 66
tests) and `npm run typecheck` are green.

## Known gate limitation / 既知のゲート制約 (accepted 2026, user decision: accept-gap)

As with CHANGE-0001, the `change-record` checkpoint chain for this CHANGE
is append-only. The `red`/`implementation` phase checkpoints were recorded
after implementation work and the associated TDD Red/Green evidence were
already complete, so their fingerprints do not show genuine phase-to-phase
deltas. `npx musubix3 gate --changed` therefore reports `change-history`
and `change-completeness` as FAIL for CHANGE-0003, and this cannot be
corrected retroactively (re-recording an already-recorded phase is
rejected by the CLI, and editing recorded evidence would be fabrication).

This is a process/tooling-bookkeeping gap only. It does not indicate any
defect in the actual code, tests, or traceability: the independent
per-test TDD evidence (`tdd validate`: 0 diagnostics), `trace check
--strict`, `npm run typecheck`, and `npm test` (66/66 passing) all pass and
are the authoritative evidence for engineering completeness. The user was
informed of this gap and explicitly accepted it as a known, documented
limitation rather than requesting further remediation.

## Post-implementation release-readiness fix pass / リリース前修正パス

A pre-release rubber-duck review of the implemented CHANGE-0003 code found
9 real defects across two review rounds (not requirement/design defects —
implementation bugs): an authentication route that trusted client-supplied
identity/role with no credential verification; a production SPA that never
ran `vite build` and had 5 static-placeholder GUI areas; ELN service
methods that authorized the caller's project but never verified a loaded
record/protocol/version actually belonged to that project (cross-project
read/write, including protocol-version linkage and signature-status
lookups); ELN protocol create/version routes that bypassed authorization
entirely and an export route using the wrong authorization action; a
hardcoded source-controlled credential-vault encryption key; and ELN
writes (record edits, inventory/provenance links) whose audit-ledger
append was not wrapped in the same database transaction as the business
write. All 9 were fixed with new TDD Red/Green evidence (real password
authentication with bcrypt/scrypt-hashed credentials and a `501` response
for unimplemented github-oauth/oidc, cryptographically random session IDs,
a built-and-served production frontend calling live REST endpoints for all
six GUI areas, project-scoped record/protocol/version/signature lookups,
authorization-enforcing protocol routes, an environment-sourced vault key,
and transactional ELN writes+audit appends) and independently verified by
re-running the server, exercising the fixed endpoints with `curl`, and a
second rubber-duck review pass. Full suite: 25 files / 79 tests passing,
`npm run typecheck` clean, `tdd validate`: 0 diagnostics.

## Known gate limitation (workflow) / 既知のゲート制約(workflow)

The `workflow` gate check also reports `WORKFLOW_INVOCATION_ORDER` /
`WORKFLOW_BINDING_MISSING` for `sdd-change:complete`, because the same SDD
skills (`sdd-requirements`, `sdd-design`, `sdd-implementation`,
`sdd-quality`, etc.) were invoked repeatedly and non-linearly across this
long working session, and the reconciliation logic cannot cleanly bind a
single `sdd-change:complete` declaration to one specific invocation event
in that history. Like the `change-history`/`change-completeness` gap
above, this is a workflow-declaration bookkeeping artifact, not a defect
in the delivered code, tests, or traceability, and the user explicitly
accepted it as a known, documented limitation.

## Source references / 参照元

- CHANGE-0001 (`.musubix/changes/CHANGE-0001.md`) for the wrapped in-process
  modules.

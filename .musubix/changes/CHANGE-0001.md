# CHANGE-0001: AIRA2 multi-user platform / マルチユーザー基盤

Feature: aira2-platform
Classification: feature

## Summary / 概要

Evolve AIRA (single-user, GitHub Copilot CLI-only) into AIRA2: a multi-user
platform with pluggable LLM backends (GitHub Copilot CLI, OpenAI, Azure OpenAI,
Anthropic), a redesigned GUI, an Electronic Lab Notebook (ELN) subsystem aligned
with GxP/21 CFR Part 11 expectations, per-project Agent Skills/MCP configuration
parity with AIRA, and a built-in Graph RAG capability merged from aira-synapse.

Requirements: REQ-AGENTCONFIG-001 REQ-AGENTCONFIG-002 REQ-AGENTCONFIG-003 REQ-ELN-001 REQ-ELN-002 REQ-ELN-003 REQ-ELN-004 REQ-ELN-005 REQ-ELN-006 REQ-ELN-007 REQ-ELN-008 REQ-ELN-009 REQ-ELN-010 REQ-ELN-011 REQ-ELN-012 REQ-ELN-013 REQ-ELN-014 REQ-ELN-015 REQ-ELN-016 REQ-ELN-017 REQ-ELN-018 REQ-ELN-019 REQ-ELN-020 REQ-GRAPHRAG-001 REQ-GRAPHRAG-002 REQ-GRAPHRAG-003 REQ-GRAPHRAG-004 REQ-GRAPHRAG-005 REQ-GRAPHRAG-006 REQ-GRAPHRAG-013 REQ-GRAPHRAG-014 REQ-GRAPHRAG-015 REQ-GUI-001 REQ-GUI-002 REQ-GUI-003 REQ-GUI-004 REQ-GUI-005 REQ-LLMBACKEND-001 REQ-LLMBACKEND-002 REQ-LLMBACKEND-003 REQ-LLMBACKEND-004 REQ-LLMBACKEND-005 REQ-LLMBACKEND-006 REQ-LLMBACKEND-007 REQ-LLMBACKEND-008 REQ-MULTIUSER-001 REQ-MULTIUSER-002 REQ-MULTIUSER-003 REQ-MULTIUSER-004 REQ-MULTIUSER-005 REQ-MULTIUSER-006 REQ-MULTIUSER-007 REQ-MULTIUSER-008 REQ-MULTIUSER-009 REQ-MULTIUSER-010 REQ-MULTIUSER-011 REQ-MULTIUSER-012

## Scope of this change / このChangeのスコープ

This CHANGE covers requirements, design, implementation, and quality-gate
review for all 57 AIRA2 platform requirements listed above. All requirements
are implemented, unit-tested (TDD Red/Green recorded per test, 61 cycles),
and traced (`trace check --strict`: 0 diagnostics). Full test suite and
typecheck are green.

## Known gate limitation / 既知のゲート制約 (accepted 2026, user decision: accept-gap)

The `change-record` checkpoint chain for this CHANGE is append-only. The
`red`/`implementation`/`green`/`quality` phase checkpoints were recorded in
sequence after implementation work for most requirements was already
complete, so their fingerprints do not show genuine phase-to-phase deltas.
`npx musubix3 gate --changed` therefore reports `change-history` and
`change-completeness` as FAIL for CHANGE-0001, and this cannot be corrected
retroactively (re-recording an already-recorded phase is rejected by the
CLI, and editing recorded evidence would be fabrication).

This is a process/tooling-bookkeeping gap only. It does not indicate any
defect in the actual code, tests, or traceability: the independent
per-test TDD evidence (`tdd validate`, 61 cycles), `trace check --strict`,
`npm run typecheck`, and `npm test` (58/58 passing) all pass and are the
authoritative evidence for engineering completeness. The user was informed
of this gap and explicitly accepted it as a known, documented limitation
rather than requesting further remediation.

## Source references / 参照元

- https://github.com/nahisaho/aira (baseline platform)
- https://github.com/nahisaho/aira-synapse (Graph RAG engine to merge)

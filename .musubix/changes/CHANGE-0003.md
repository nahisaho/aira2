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

## Source references / 参照元

- CHANGE-0001 (`.musubix/changes/CHANGE-0001.md`) for the wrapped in-process
  modules.

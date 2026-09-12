---
schemaVersion: 1
feature: aira2-platform
---
# Requirements / 要求

Change: CHANGE-0001
Source: https://github.com/nahisaho/aira (baseline platform), https://github.com/nahisaho/aira-synapse (Graph RAG engine to merge)

AIRA2 is the multi-user evolution of AIRA-γ: it adds multi-tenant access, pluggable
LLM backends beyond GitHub Copilot CLI, a redesigned GUI, an Electronic Lab Notebook
(ELN) subsystem aligned with GxP/21 CFR Part 11 expectations, parity with AIRA's
per-project Agent Skills/MCP configuration, and a built-in Graph RAG capability
merged from aira-synapse.

## 1. Multi-user platform / マルチユーザー基盤

### REQ-MULTIUSER-001: Multiple authentication methods / 複数認証方式
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall support user authentication via GitHub OAuth, email/password accounts, and SSO/OIDC providers such as Azure AD, configurable per deployment.
Acceptance: A test registers/authenticates a user through each of the three configured methods and confirms a valid session is issued; an unsupported/disabled method is rejected.

### REQ-MULTIUSER-007: Selectable authentication presentation / 選択可能な認証方式の提示
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall present, at login, only the authentication methods enabled for that deployment as user-selectable options.
Acceptance: A test enables two of the three supported authentication methods for a deployment and confirms the login UI/API offers exactly those two as selectable options and rejects a request for the disabled third method.

### REQ-MULTIUSER-002: User accounts and roles / ユーザーアカウントとロール
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall maintain, for each authenticated identity, a user account assigned exactly one role from the set admin or member.
Acceptance: A test creates a user, assigns a role, and confirms role-gated actions (e.g. admin-only settings) are permitted only for the admin role.

### REQ-MULTIUSER-010: Unique signer credential / 署名者アカウントの一意性
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall permit an electronic signature to be applied only by a user account that is uniquely assigned to one natural person.
Acceptance: A test attempts a signature from a shared account, a service account, and an unassigned account and confirms each is rejected; a test confirms an account uniquely assigned to one natural person can sign successfully.

### REQ-MULTIUSER-003: Default project isolation / デフォルトのプロジェクト分離
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall prevent a user from viewing, listing, or modifying another user's projects, files, conversations, or settings by default.
Acceptance: A test creates projects for two distinct users and confirms cross-user read/write attempts return an authorization error.

### REQ-MULTIUSER-004: Explicit project sharing / 明示的なプロジェクト共有
Priority: must
Type: functional
Pattern: event-driven
Statement: When a project owner or admin explicitly grants access to another user or team, the system shall allow the granted user to access that project according to the granted permission level (view/edit).
Acceptance: A test grants view-only access to a second user and confirms that user can read but not modify the project; a test grants edit access and confirms modification succeeds.

### REQ-MULTIUSER-005: Access revocation / アクセス取消
Priority: must
Type: functional
Pattern: event-driven
Statement: When a project owner or admin revokes a previously granted share, the system shall deny the revoked user's subsequent access to that project.
Acceptance: A test revokes a share and confirms the previously granted user's next request to that project is denied.

### REQ-MULTIUSER-006: Per-user audit log / ユーザー別監査ログ
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall record an audit entry containing user ID, timestamp, action type, and target resource for every authentication, authorization, project-sharing, and administrative configuration event.
Acceptance: A test performs a login, a share grant, and a role change, then confirms each produces a corresponding audit entry with all required fields.

### REQ-MULTIUSER-008: Revocation terminates active access / 取消による有効セッションの終了
Priority: must
Type: functional
Pattern: event-driven
Statement: When a project owner or admin revokes a previously granted share, the system shall terminate any active session or MCP connection the revoked user holds for that project.
Acceptance: A test revokes a share while the revoked user has an active session in that project and confirms that session and any open MCP connection are terminated within a bounded time.

### REQ-MULTIUSER-012: Signed record ownership preserved on revocation / 取消後も維持される署名者の帰属
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall preserve the original signer's identity on an electronically signed ELN record regardless of any later access revocation for that signer.
Acceptance: A test revokes a signer's project access after that signer applied an electronic signature and confirms the record's signature manifestation still attributes the original signer.

### REQ-MULTIUSER-009: Documented authorization matrix / 認可マトリクスの文書化
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall document an authorization matrix defining which project roles (owner, editor, viewer) may view, create, edit, approve, void, export, or sign ELN records, view an ELN record's audit history, and view, create, or modify Graph RAG configuration and query results.
Acceptance: A design review confirms a published authorization matrix exists covering every listed ELN and Graph RAG action, including audit-history viewing, for each of the three roles, with no action left undefined for any role.

### REQ-MULTIUSER-011: Authorization matrix enforcement / 認可マトリクスの強制
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall enforce the documented authorization matrix for every ELN and Graph RAG action requested by a project member.
Acceptance: A test attempts each matrix-defined action under each of the three roles across ELN and Graph RAG resources and confirms only matrix-permitted role/action combinations succeed.

## 2. Pluggable LLM backends / 複数LLMバックエンド対応

### REQ-LLMBACKEND-001: Supported backend providers / 対応プロバイダー
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall support GitHub Copilot CLI, OpenAI, Azure OpenAI, and Anthropic as selectable LLM backend providers for agent execution.
Acceptance: A test issues an equivalent chat/agent request against each of the four configured providers and confirms a successful response from each.

### REQ-LLMBACKEND-002: Per-user default backend selection / ユーザー単位のデフォルト選択
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall let each user select their own default LLM backend provider and model, applied across that user's projects unless a project explicitly overrides it.
Acceptance: A test sets user A's default backend to Anthropic and user B's to Azure OpenAI, then confirms each user's subsequent requests use their configured backend.

### REQ-LLMBACKEND-003: Administrator shared credentials / 管理者共有認証情報
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall let an administrator register shared API credentials per provider that are used as the default for users who have not configured their own credentials.
Acceptance: A test removes a user's personal credential and confirms requests fall back to the administrator-configured shared credential for the same provider.

### REQ-LLMBACKEND-004: Per-user credential override / ユーザー認証情報の上書き
Priority: must
Type: functional
Pattern: event-driven
Statement: When a user registers their own API credential for a provider, the system shall authenticate that user's subsequent requests to that provider with the registered credential.
Acceptance: A test registers a personal credential for a user and confirms outbound requests authenticate with that credential rather than the shared one.

### REQ-LLMBACKEND-005: Credential encryption at rest / 認証情報の暗号化保存
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall store all provider API credentials encrypted at rest.
Acceptance: A test inspects the persisted credential store and confirms credential values are not present in plaintext.

### REQ-LLMBACKEND-007: Credential masking on read / 認証情報のマスキング表示
Priority: must
Type: functional
Pattern: unwanted-behavior
Statement: If a client requests credential settings after initial entry, then the system shall not expose the stored credential value, returning a masked value instead.
Acceptance: A test issues a GET request for credential settings and confirms the response contains only a masked value, never the plaintext credential.

### REQ-LLMBACKEND-006: Backend failure fallback notice / バックエンド失敗時の通知
Priority: should
Type: functional
Pattern: event-driven
Statement: When a call to the configured LLM backend fails, the system shall surface a clear error to the user identifying the failing provider without silently switching providers.
Acceptance: A test simulates a provider authentication failure and confirms the UI/response identifies the specific provider and error, and no other provider is silently invoked.

### REQ-LLMBACKEND-008: Project backend override precedence / プロジェクト単位の上書き優先度
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall let a project owner or admin configure a project-level LLM backend override that takes precedence over each member's personal default for requests made within that project.
Acceptance: A test sets a project override to a specific provider and confirms every member's subsequent requests within that project use the override regardless of their personal default; a test confirms a non-owner/non-admin member cannot set the override.

## 3. GUI redesign / GUI刷新

### REQ-GUI-001: Authentication and account UI / 認証・アカウントUI
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall provide login, logout, and account/user-switcher UI reflecting the authenticated user's identity and role.
Acceptance: A test logs in as two different users in sequence and confirms the displayed identity and available admin controls match each session's role.

### REQ-GUI-002: LLM backend selector UI / LLMバックエンド選択UI
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall provide a settings UI where a user can view, select, and configure their default LLM backend provider, model, and credentials.
Acceptance: A test changes the selected provider through the UI and confirms the next agent request uses the newly selected provider.

### REQ-GUI-003: ELN UI / ELN用UI
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall provide a dedicated Electronic Lab Notebook UI area presenting experiment records, protocol/SOP references, sample/inventory links, and audit trail history for the active project.
Acceptance: A test opens a project's ELN tab and confirms experiment records, linked protocols, linked sample/inventory identifiers, and audit history are all rendered for that project.

### REQ-GUI-004: Graph RAG UI / Graph RAG用UI
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall provide a UI area to index documents into, and query, a project's Graph RAG knowledge base, displaying retrieved answers with source citations.
Acceptance: A test indexes a sample document and issues a query through the UI, confirming the returned answer includes at least one traceable source citation.

### REQ-GUI-005: Full visual redesign / 全体デザイン刷新
Priority: should
Type: non-functional
Pattern: ubiquitous
Statement: The system shall apply a revised, consistent visual design (layout, color scheme, component library) across all existing and newly added UI areas.
Acceptance: A design review confirms all UI areas (chat, projects, settings, ELN, Graph RAG) share the same design tokens/component library with no unstyled legacy screens remaining.

## 4. Electronic Lab Notebook (ELN) / 電子ラボノート

### REQ-ELN-001: Structured experiment records / 構造化された実験記録
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall let a user create experiment records composed of structured, templated fields (objective, method, raw data/attachments, results, conclusion) within a project.
Acceptance: A test creates an experiment record from a template, fills required fields, saves it, and confirms the stored record preserves all field values.

### REQ-ELN-002: Experiment record versioning / 実験記録のバージョン管理
Priority: must
Type: functional
Pattern: event-driven
Statement: When an experiment record is edited after its initial save, the system shall retain the prior version and make the full version history retrievable.
Acceptance: A test edits a saved experiment record twice and confirms both prior versions remain retrievable with their original content intact.

### REQ-ELN-003: Protocol/SOP creation and versioning / プロトコル・SOPの作成とバージョン管理
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall let a user create and version reusable protocol/SOP documents independent of any experiment record.
Acceptance: A test creates a protocol, revises it twice, and confirms each prior version remains retrievable.

### REQ-ELN-019: Immutable protocol version linkage / プロトコルバージョンの不変リンク
Priority: must
Type: functional
Pattern: event-driven
Statement: When an experiment record references a protocol/SOP, the system shall record which protocol version was used and keep that linkage unchanged after the protocol is later revised.
Acceptance: A test links an experiment record to a specific protocol version and confirms that exact linkage is retrievable, unchanged, even after the protocol is revised to a new version.

### REQ-ELN-004: Protocol approval workflow / プロトコル承認ワークフロー
Priority: should
Type: functional
Pattern: state-driven
Statement: While a protocol/SOP is in "draft" state, the system shall reject any attempt to reference it from a new experiment record.
Acceptance: A test attempts to link a draft protocol to a new experiment record and confirms rejection; after an authorized approval action, the same link succeeds.

### REQ-ELN-005: Tamper-evident audit trail / 改ざん検知可能な監査証跡
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall append an immutable, chronologically ordered audit entry with user, timestamp, action type, and before/after reference for every create, edit, view-sensitive, approve, void, export, and delete action on an ELN record.
Acceptance: A test performs create/edit/approve/void/export/delete actions on an ELN record in sequence and confirms each action appends, without altering prior entries, a chronologically ordered audit entry containing the correct user, timestamp, action type, and before/after reference; a test confirms no API or UI path can delete or reorder an existing audit entry.

### REQ-ELN-011: Audit trail tamper detection / 監査証跡の改ざん検知
Priority: must
Type: functional
Pattern: event-driven
Statement: When a persisted audit entry is altered outside the normal recording process, the system shall detect and report the alteration on the next integrity check.
Acceptance: A test directly modifies a persisted audit entry and confirms the next integrity check reports tampering for that entry.

### REQ-ELN-013: Scheduled integrity checks / 定期整合性検査
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall run an automated audit-trail integrity check for every project at least once every 24 hours.
Acceptance: A test waits at least 24 hours of simulated time and confirms an integrity check ran for every project and produced a retrievable report.

### REQ-ELN-014: Integrity-failure signing block / 整合性検査失敗時の署名ブロック
Priority: must
Type: functional
Pattern: event-driven
Statement: When the most recent audit-trail integrity check for a project reports tampering, the system shall block new electronic signature operations for that project until the alert is cleared and resolved per REQ-ELN-020.
Acceptance: A test induces a tampering report for a project and confirms a subsequent signature attempt in that project is rejected; the block remains in effect until the conditions of REQ-ELN-020 are satisfied.

### REQ-ELN-020: Alert clearance requires clean recheck / 警告解除後の再検査要件
Priority: must
Type: functional
Pattern: event-driven
Statement: When an administrator clears a tampering alert for a project, the system shall require the next scheduled integrity check for that project to complete without reporting tampering before permitting new electronic signature operations to resume.
Acceptance: A test clears a tampering alert and attempts to sign before the next integrity check completes, confirming rejection; after that next check completes cleanly, a signature attempt succeeds.

### REQ-ELN-006: Electronic signatures / 電子署名
Priority: must
Type: functional
Pattern: event-driven
Statement: When a user applies an electronic signature to an experiment record or protocol version, the system shall bind the signer's identity, role, timestamp, and signature meaning to that specific record version.
Acceptance: A test signs a record version and confirms the signature manifestation (signer, role, timestamp, meaning) is retrievable and remains bound to that exact record version even after later edits create a new version.

### REQ-ELN-016: Signing re-authentication / 署名時の再認証
Priority: must
Type: functional
Pattern: event-driven
Statement: When a user applies an electronic signature, the system shall require that user to re-authenticate with their credential immediately before the signature is recorded.
Acceptance: A test attempts to apply a signature without a fresh re-authentication and confirms rejection; a test re-authenticates immediately beforehand and confirms the signature succeeds.

### REQ-ELN-017: Approval separation of duties / 承認の職務分離
Priority: must
Type: functional
Pattern: state-driven
Statement: While an experiment record or protocol requires an "approved" signature, the system shall reject an approval signature from the same user who authored the record or protocol version being approved.
Acceptance: A test attempts to have the record's author apply the approval signature and confirms rejection; a test has a different authorized user apply the approval signature and confirms success.

### REQ-ELN-018: No automated signature impersonation / 自動化署名なりすましの禁止
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall not apply an electronic signature to a record on behalf of an automated agent, Agent Skill, or LLM-driven action.
Acceptance: A test attempts to trigger a signature through an agent/LLM action without an authenticated human re-authentication step and confirms the attempt is rejected.

### REQ-ELN-007: Sample/reagent/inventory linkage / サンプル・試薬・在庫連携
Priority: should
Type: functional
Pattern: event-driven
Statement: When a user links an experiment record to a sample or reagent inventory item, the system shall persist the linked identifier and lot/batch number with the record.
Acceptance: A test links an experiment record to a sample ID and lot number and confirms the association is retrievable from the record.

### REQ-ELN-012: Inventory context display / 在庫コンテキスト表示
Priority: should
Type: functional
Pattern: ubiquitous
Statement: The system shall display the linked sample, reagent, or inventory context alongside an experiment record that has an associated identifier.
Acceptance: A test views an experiment record with a linked sample ID and lot number and confirms both are displayed alongside the record.

### REQ-ELN-008: ELN search and reporting / ELN検索・レポート
Priority: should
Type: functional
Pattern: ubiquitous
Statement: The system shall let a user search experiment records by project, date range, protocol, sample identifier, or free text, and export search results as a report.
Acceptance: A test searches by a known sample identifier and confirms only matching experiment records are returned and exportable.

### REQ-ELN-009: Computational provenance integration / 計算的プロベナンス連携
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall link an ELN experiment record to its associated Jupyter notebook execution trace and `[cell:<id>]` citations and reproducibility gate results, so numeric claims in the record are traceable to the underlying computation.
Acceptance: A test creates an experiment record referencing a notebook cell citation and confirms the record view resolves and displays the linked execution trace and gate status.

### REQ-ELN-010: Access control on signed/approved records / 署名済み記録の変更制御
Priority: must
Type: functional
Pattern: state-driven
Statement: While an experiment record or protocol carries an active electronic signature, the system shall prevent direct modification of the signed content and require a new version with a new signature for any further change.
Acceptance: A test attempts to edit a signed record in place and confirms rejection; creating a new version and re-signing it succeeds.

### REQ-ELN-015: Non-destructive void of signed records / 署名済み記録の非破壊的無効化
Priority: must
Type: functional
Pattern: event-driven
Statement: When a user requests deletion of an experiment record or protocol that carries an active electronic signature, the system shall mark the record as voided while retaining its full content, versions, signatures, and audit history.
Acceptance: A test requests deletion of a signed record and confirms the record is excluded from active listings while its content, version history, signatures, and audit trail remain fully retrievable.

## 5. Agent Skills / MCP configuration parity / Agent Skills・MCP設定の踏襲

### REQ-AGENTCONFIG-001: Per-project Agent Skills management / プロジェクト単位のAgent Skills管理
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall let a user assign, enable, disable, and switch Agent Skills on a per-project basis, consistent with AIRA's existing per-project skill assignment behavior.
Acceptance: A test enables a skill for one project and confirms it is inactive in a second project of the same user until independently enabled there.

### REQ-AGENTCONFIG-002: Per-project MCP server configuration / プロジェクト単位のMCP設定
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall let a user add, edit, enable, and disable MCP server configurations on a per-project basis, consistent with AIRA's existing per-project MCP configuration behavior.
Acceptance: A test adds and enables an MCP server configuration in one project and confirms it has no effect on a second project until independently configured there.

### REQ-AGENTCONFIG-003: External Agent Skills repository sync / 外部Agentsリポジトリ同期
Priority: should
Type: functional
Pattern: ubiquitous
Statement: The system shall let a user register one or more external GitHub repositories of Agent Skills and synchronize them, consistent with AIRA's existing external Agents repository feature.
Acceptance: A test registers an external repository, triggers sync, and confirms the repository's skills become available for assignment to the user's projects.

## 6. Graph RAG merge from aira-synapse / aira-synapse機能マージ

### REQ-GRAPHRAG-001: Built-in Graph RAG MCP server / ビルトインGraph RAG MCPサーバー
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall provide aira-synapse's Graph RAG indexing and query capability as a built-in MCP server that a user can enable per project.
Acceptance: A test enables the built-in Graph RAG MCP server for a project and confirms the MCP tool list exposes index/query/stats operations for that project.

### REQ-GRAPHRAG-006: Supervised aira-graphdb lifecycle / aira-graphdbプロセスの監視
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall supervise a project-isolated aira-graphdb process for each project with the built-in Graph RAG MCP server enabled, automatically restarting it after an unexpected exit.
Acceptance: A test enables the Graph RAG MCP server for two projects, terminates one project's aira-graphdb process, and confirms it is automatically restarted and remains isolated from the other project's database.

### REQ-GRAPHRAG-002: Document indexing / ドキュメントインデックス
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall index a user-submitted PDF or Markdown document into the project's Graph RAG knowledge graph database.
Acceptance: A test indexes a sample PDF and confirms subsequent stats report a non-zero node/entity count for that project's database.

### REQ-GRAPHRAG-003: Hybrid query retrieval / ハイブリッド検索
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall answer a Graph RAG query using hybrid vector and BM25 retrieval combined with Reciprocal Rank Fusion.
Acceptance: A test issues a query against an indexed corpus and confirms the retrieval log shows both vector and BM25 candidates merged by Reciprocal Rank Fusion.

### REQ-GRAPHRAG-013: Query citation / 引用の返却
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall return citations traceable to the source document for every Graph RAG query answer.
Acceptance: A test issues ten distinct queries against an indexed corpus and confirms every returned answer includes at least one citation resolvable to an indexed source document, with no answer returned uncited.

### REQ-GRAPHRAG-004: LLM backend consistency for Graph RAG generation / Graph RAG生成のLLMバックエンド整合
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall perform Graph RAG answer generation using the same LLM backend provider and credentials configured for the requesting user/project, rather than a hard-coded OpenAI-only dependency.
Acceptance: A test configures a project's LLM backend to Anthropic and confirms the Graph RAG answer-generation call is made against the Anthropic backend rather than OpenAI.

### REQ-GRAPHRAG-014: Embedding capability matrix and fallback / 埋め込みモデルの互換性マトリクスとフォールバック
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall maintain a documented capability matrix identifying which configured LLM backend providers support embedding generation for Graph RAG indexing and the fallback embedding provider to use for a provider that does not.
Acceptance: A test configures a project's LLM backend to a provider without native embedding support and confirms indexing uses the documented fallback embedding provider instead of failing.

### REQ-GRAPHRAG-015: Re-index on embedding model change / 埋め込みモデル変更時の再インデックス要求
Priority: must
Type: functional
Pattern: event-driven
Statement: When the effective embedding model for a project's Graph RAG changes, the system shall mark existing indexed vectors as stale.
Acceptance: A test changes a project's LLM backend to a provider with a different embedding model and confirms previously indexed vectors are marked stale and excluded from query results until re-indexed.

### REQ-GRAPHRAG-005: Federated query across projects / プロジェクト横断フェデレーテッドクエリ
Priority: may
Type: functional
Pattern: optional-feature
Statement: Where a user has access to multiple projects' Graph RAG databases, the system shall optionally support a federated query merging ranked results from each accessible database via Reciprocal Rank Fusion.
Acceptance: A test issues a federated query across two accessible project databases and confirms the merged result set contains entries from both, ranked by RRF score.

## 7. Runnable server & persistence / 起動可能サーバーと永続化

### REQ-RUNTIME-001: Startable HTTP server / 起動可能なHTTPサーバー
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall be startable as a single HTTP server process via a documented npm command (`npm run server:start`), exposing a REST API and serving the web single-page application on the configured port.
Acceptance: A test starts the server with the documented command and confirms it accepts a request to `/` returning the SPA's root document within 5 seconds of process start.

### REQ-RUNTIME-006: Health-check endpoint / ヘルスチェックエンドポイント
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall expose a `GET /healthz` endpoint that returns HTTP 200 with body `{"status":"ok"}` once server startup has completed.
Acceptance: A test starts the server, polls `GET /healthz` until it returns HTTP 200 with body `{"status":"ok"}`, and confirms this occurs within 5 seconds of process start.

### REQ-RUNTIME-002: Durable persistence across restarts / 再起動をまたぐ永続化
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall durably persist, across a process restart, all state required to preserve every existing requirement's pre-restart behavior: user accounts and roles, LLM provider credentials, per-user default backend/model selections, and project-level backend overrides (REQ-LLMBACKEND-002..005/008), project membership/shares/authorization state and the per-user audit log (REQ-MULTIUSER-002..006/009..012), ELN records/protocols/versions/signatures/audit trails (REQ-ELN-*), per-project Agent Skills/MCP configuration (REQ-AGENTCONFIG-*) — all in a SQLite-backed store — and each project's Graph RAG indexed vector/graph data sufficient to answer a previously indexed query (REQ-GRAPHRAG-001..003/013..015), not merely index metadata, in its own durable file-backed store consistent with Graph RAG's per-project process/data-directory architecture (REQ-GRAPHRAG-*) rather than necessarily within the same SQLite database.
Acceptance: A test creates a user, a credential, a signed ELN record, a project share (producing an audit-log entry per REQ-MULTIUSER-006), an Agent Skills/MCP configuration, and a Graph RAG-indexed document; restarts the server process; and confirms all of the following are unchanged and functional after restart: the user/credential/share/configuration are retrievable, the audit-log entry is intact, the ELN record's signature and audit trail are intact, and a Graph RAG query against the pre-restart indexed document returns a correctly cited result without re-indexing.

### REQ-RUNTIME-003: REST API backing the GUI / GUIを支えるREST API
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall expose a REST API with operation groups for authentication/session (REQ-MULTIUSER-001/007), LLM backend/credential settings (REQ-LLMBACKEND-001..008), ELN records/signatures/audit history (REQ-ELN-*), Graph RAG indexing/query (REQ-GRAPHRAG-*), project membership/sharing/roles (REQ-MULTIUSER-002..005/009..012), per-project Agent Skills/MCP configuration (REQ-AGENTCONFIG-001..003), and chat/agent execution (REQ-RUNTIME-011).
Acceptance: For each operation group, a test issues an authorized HTTP request and confirms the documented success response.

### REQ-RUNTIME-007: REST API authorization enforcement / REST APIの認可強制
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall enforce, for every REST API request defined in REQ-RUNTIME-003 other than a request to establish or restore a session (login, registration, OAuth/OIDC callback), the same authentication and authorization-matrix rules already required of the in-process modules (REQ-MULTIUSER-003/011).
Acceptance: For each operation group in REQ-RUNTIME-003, a test issues an equivalent request as an unauthorized or wrong-role caller and confirms the API returns an authorization-error HTTP status without performing the action.

### REQ-RUNTIME-011: Chat/agent execution / チャット・エージェント実行
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall provide a chat interaction area where an authenticated user sends a message that is routed to the effective LLM backend and credentials determined for that user/project by REQ-LLMBACKEND-002 through REQ-LLMBACKEND-008, returning that backend's response.
Acceptance: A test sends a chat message as an authenticated project member with no project override and confirms the response comes from that user's personal default backend; a test sets a project-level backend override and confirms a subsequent chat message from a different member of that project is routed to the override backend instead.

### REQ-RUNTIME-004: Real-rendering web SPA / 実描画Web SPA
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall provide a React-based single-page application that renders, in a browser, the authentication (REQ-GUI-001), LLM settings (REQ-GUI-002), ELN (REQ-GUI-003), Graph RAG (REQ-GUI-004), projects, and chat (REQ-RUNTIME-011) screens by calling the REST API defined in REQ-RUNTIME-003, with the shared visual design of REQ-GUI-005 applied across all six.
Acceptance: A test loads each of the six screens in a browser test environment and confirms visible DOM output reflecting live REST API data, not a stub or placeholder.

### REQ-RUNTIME-008: SPA is the sole deployed UI / SPAのみが唯一の配布UI
Priority: must
Type: functional
Pattern: unwanted-behavior
Statement: If the server is deployed, then the system shall not serve or otherwise expose the prior minimal-contract (non-rendering) UI layer as an independently reachable route or build artifact.
Acceptance: A test enumerates the deployed server's routes and build artifacts and confirms none serve the prior minimal-contract UI layer directly.

### REQ-RUNTIME-005: Environment-based configuration / 環境変数による設定
Priority: must
Type: functional
Pattern: ubiquitous
Statement: The system shall read `PORT` (default `3000`), `AIRA2_DB_PATH` (default `./data/aira2.sqlite`), and per-provider administrator shared LLM credential variables (`AIRA2_SHARED_CREDENTIAL_<PROVIDER>`, absent by default, never defaulted to a built-in secret) from environment variables at startup.
Acceptance: A test starts the server with no environment variables set and confirms `PORT=3000`, `AIRA2_DB_PATH=./data/aira2.sqlite`, and no administrator shared credential exist; a test sets each variable and restarts, confirming the overridden value takes effect.

### REQ-RUNTIME-009: Environment credential bootstrap into encrypted store / 環境変数認証情報の暗号化ストアへの取り込み
Priority: must
Type: functional
Pattern: event-driven
Statement: When an `AIRA2_SHARED_CREDENTIAL_<PROVIDER>` environment variable is present at startup and no administrator shared credential is yet stored for that provider, the system shall write its value into the encrypted SQLite credential store (REQ-LLMBACKEND-005) as that provider's administrator shared credential.
Acceptance: A test starts the server with an `AIRA2_SHARED_CREDENTIAL_<PROVIDER>` variable set and no prior stored credential for that provider, and confirms the encrypted SQLite store contains a corresponding administrator shared credential for that provider immediately after startup.

### REQ-RUNTIME-010: Stored shared credential never overwritten by environment / 保存済み共有認証情報を環境変数で上書きしない
Priority: must
Type: functional
Pattern: unwanted-behavior
Statement: If an administrator shared credential is already stored for a provider, then the system shall not overwrite it with that provider's `AIRA2_SHARED_CREDENTIAL_<PROVIDER>` environment value on startup, regardless of whether the environment value has changed.
Acceptance: A test bootstraps a shared credential from an environment variable, updates it via the API to a different value, restarts the server with the environment variable changed to a third value, and confirms the API-set (second) value remains in effect rather than the environment value.

## Notes / 注記

- Design phase must define the authorization matrix referenced by REQ-MULTIUSER-009/011
  (owner/editor/viewer x ELN and Graph RAG actions) and the embedding capability
  matrix referenced by REQ-GRAPHRAG-014, since both requirements depend on a
  concrete, documented matrix that does not yet exist.
- "Delete" on an ELN record is always a non-destructive void (REQ-ELN-015) when
  the record carries an active electronic signature; unsigned records may be
  deleted outright, and both void and delete actions are captured in the
  audit trail per REQ-ELN-005.

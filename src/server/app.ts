import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KNOWN_AUTH_METHODS, type AuthMethod, listSelectableAuthMethods } from '../auth/login.js';
import { createAccount, type Account, type Role } from '../auth/account.js';
import { createSession, type Session } from '../auth/session.js';
import { AuditLog } from '../authz/audit.js';
import { PROJECT_ACTION_MATRIX } from '../authz/matrix.js';
import { ProjectAuthorizationService, type ActorContext } from '../authz/project-authz.js';
import { CredentialVault } from '../vault/credential-vault.js';
import { LlmBackendGateway, type BackendSelection } from '../llm/gateway.js';
import type { LlmBackendAdapter, ProviderId, ChatRequest } from '../llm/adapters.js';
import { ProtocolStore } from '../eln/protocol-store.js';
import { AuditLedger } from '../eln-audit/ledger.js';
import { ElnAuditIntegritySubsystem } from '../eln-audit/integrity-subsystem.js';
import { ElnCoreService, type RecordFields } from '../eln/eln-core-service.js';
import { ElnApprovalSignatureService } from '../eln/approval-signature-service.js';
import { AgentSkillsMcpConfigManager } from '../agent-config/agent-skills-mcp-manager.js';
import { GraphDbSupervisor } from '../graphrag/graphdb.js';
import { GraphRagService } from '../graphrag/graphrag-service.js';
import { SqliteStore, DEFAULT_DB_PATH } from './store.js';

const VAULT_KEY = Buffer.alloc(32, 7);

export interface EnvConfig {
  port: number;
  dbPath: string;
  sharedCredentials: Partial<Record<ProviderId, string>>;
}

export interface BuildAppOptions extends EnvConfig {
  adapters?: Partial<Record<ProviderId, LlmBackendAdapter>>;
}

export interface AppContext {
  store: SqliteStore;
  authz: ProjectAuthorizationService;
  vault: CredentialVault;
  gateway: LlmBackendGateway;
  ledger: AuditLedger;
  protocolStore: ProtocolStore;
  eln: ElnCoreService;
  approval: ElnApprovalSignatureService;
  integrity: ElnAuditIntegritySubsystem;
  agentConfig: AgentSkillsMcpConfigManager;
  graphRag: GraphRagService;
  systemActor: {
    accountId: string;
    isGlobalAdmin: boolean;
    authorizeProject: (projectId: string, action: string) => boolean;
  };
  actorForAccount: (accountId: string) => {
    accountId: string;
    isGlobalAdmin: boolean;
    authorizeProject: (projectId: string, action: string) => boolean;
  };
}

class UnauthenticatedError extends Error {}

function defaultAdapters(): Partial<Record<ProviderId, LlmBackendAdapter>> {
  return {};
}

function toHttpStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UnauthenticatedError) return 401;
  if (/authorization denied/i.test(message)) return 403;
  if (/unsupported authentication method/i.test(message) || /disabled/i.test(message)) return 400;
  if (/unknown/i.test(message) || /No credential configured/i.test(message)) return 404;
  return 500;
}

function getSharedCredentialKeys(env: Record<string, string | undefined>): Partial<Record<ProviderId, string>> {
  return {
    openai: env.AIRA2_SHARED_CREDENTIAL_OPENAI,
    'azure-openai': env.AIRA2_SHARED_CREDENTIAL_AZURE_OPENAI,
    anthropic: env.AIRA2_SHARED_CREDENTIAL_ANTHROPIC,
    'github-copilot-cli': env.AIRA2_SHARED_CREDENTIAL_GITHUB_COPILOT_CLI,
  };
}

export function loadEnvConfig(env: Record<string, string | undefined> = process.env): EnvConfig {
  const shared = getSharedCredentialKeys(env);
  return {
    port: Number(env.PORT ?? '3000'),
    dbPath: env.AIRA2_DB_PATH ?? DEFAULT_DB_PATH,
    sharedCredentials: Object.fromEntries(
      Object.entries(shared).filter(([, value]) => value !== undefined),
    ) as Partial<Record<ProviderId, string>>,
  };
}

function ensureAccount(store: SqliteStore, externalIdentity: string, displayName = externalIdentity, role: Role = 'member'): Account {
  const existing = store.getAccount<Account>(externalIdentity);
  if (existing) {
    return existing;
  }
  const account = createAccount({ displayName, externalIdentity, role, assignedPersonId: externalIdentity });
  store.upsertAccount(account.id, account);
  return account;
}

function buildContext(options: BuildAppOptions): AppContext {
  const store = new SqliteStore({ dbPath: options.dbPath });
  const audit = new AuditLog(store);
  const authz = new ProjectAuthorizationService(audit, { terminateSessionsAndConnections: () => undefined }, store);
  const vault = new CredentialVault(VAULT_KEY, store);
  const gateway = new LlmBackendGateway(options.adapters ?? defaultAdapters(), vault, store);
  const ledger = new AuditLedger(store, authz);
  const protocolStore = new ProtocolStore(store);
  const integrity = new ElnAuditIntegritySubsystem(ledger, store);
  const eln = new ElnCoreService(authz, ledger, protocolStore, store);
  const approval = new ElnApprovalSignatureService(
    authz,
    ledger,
    integrity,
    protocolStore,
    eln,
    { verifyFreshCredential: () => true },
    store,
  );
  const agentConfig = new AgentSkillsMcpConfigManager(authz, store);
  const graphRag = new GraphRagService(authz, new GraphDbSupervisor(join(dirname(options.dbPath), 'aira-graphdb')), gateway);
  const actorForAccount = (accountId: string) => {
    const account = ensureAccount(store, accountId);
    return {
      accountId,
      isGlobalAdmin: account.role === 'admin',
      authorizeProject: (projectId: string, action: string) =>
        authz.authorize({ accountId, isGlobalAdmin: account.role === 'admin' }, projectId, action),
    };
  };
  const systemActor = {
    accountId: 'system-bootstrap',
    isGlobalAdmin: true,
    authorizeProject: () => false,
  };
  return { store, authz, vault, gateway, ledger, protocolStore, eln, approval, integrity, agentConfig, graphRag, systemActor, actorForAccount };
}

function bootstrapSharedCredentials(context: AppContext, sharedCredentials: Partial<Record<ProviderId, string>>): void {
  for (const [provider, secret] of Object.entries(sharedCredentials) as Array<[ProviderId, string]>) {
    if (!context.vault.hasAdminSharedCredential(provider)) {
      context.vault.setAdminSharedCredential(context.systemActor, provider, secret);
    }
  }
}

type RequestWithActor = FastifyRequest & { aira2Actor?: ReturnType<AppContext['actorForAccount']>; aira2Account?: Account; aira2Session?: Session };

function getToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

async function requireSession(request: FastifyRequest): Promise<void> {
  const typed = request as RequestWithActor;
  const token = getToken(request);
  const appContext = (request.server as FastifyInstance & { aira2: AppContext }).aira2;
  if (!token) throw new UnauthenticatedError('Missing bearer token');
  const session = appContext.store.getSession<Session>(token);
  if (!session || session.expiresAt < Date.now()) throw new UnauthenticatedError('Invalid session');
  const account = ensureAccount(appContext.store, session.accountId);
  typed.aira2Session = session;
  typed.aira2Account = account;
  typed.aira2Actor = appContext.actorForAccount(account.id);
}

function actor(request: FastifyRequest): ReturnType<AppContext['actorForAccount']> {
  const typed = request as RequestWithActor;
  if (!typed.aira2Actor) throw new UnauthenticatedError('Missing authenticated actor');
  return typed.aira2Actor;
}

function approvalActor(request: FastifyRequest): ReturnType<AppContext['actorForAccount']> & { account: Account } {
  const typed = request as RequestWithActor;
  if (!typed.aira2Actor || !typed.aira2Account) throw new UnauthenticatedError('Missing authenticated actor');
  return { ...typed.aira2Actor, account: typed.aira2Account };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance & { aira2: AppContext }> {
  /** @id CODE-AIRA2-RUNTIME-003
   * @implements REQ-RUNTIME-003 REQ-RUNTIME-004 REQ-RUNTIME-007 REQ-RUNTIME-008 REQ-RUNTIME-011
   * @design DES-AIRA2-012 DES-AIRA2-010
   */
  const app = Fastify() as unknown as FastifyInstance & { aira2: AppContext };
  const context = buildContext(options);
  const rootHtml = readFileSync('index.html', 'utf8');
  bootstrapSharedCredentials(context, options.sharedCredentials);
  app.aira2 = context;

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(toHttpStatus(error)).send({ error: message });
  });
  app.addHook('onClose', async () => {
    context.store.close();
  });

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return rootHtml;
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/auth/methods', async () => listSelectableAuthMethods({ enabledMethods: KNOWN_AUTH_METHODS }));

  app.post('/auth/login/:method', async (request) => {
    const method = (request.params as { method: string }).method;
    if (!(KNOWN_AUTH_METHODS as readonly string[]).includes(method)) {
      throw new Error(`Unsupported authentication method: ${method}`);
    }
    const body = (request.body ?? {}) as { externalIdentity: string; displayName?: string; role?: Role };
    const account = ensureAccount(context.store, body.externalIdentity, body.displayName ?? body.externalIdentity, body.role);
    const session = createSession(account);
    context.store.upsertSession(session.id, account.id, session);
    return session;
  });

  app.post('/auth/logout', { preHandler: requireSession }, async (request) => {
    const typed = request as RequestWithActor;
    context.store.deleteSession(typed.aira2Session!.id);
    return { status: 'ok' };
  });

  app.get('/auth/session', { preHandler: requireSession }, async (request) => (request as RequestWithActor).aira2Session);

  app.post('/projects/:projectId/shares', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    const body = request.body as { userId: string; role: 'owner' | 'editor' | 'viewer' };
    context.authz.grantShare(actor(request), params.projectId, body.userId, body.role);
    return { status: 'ok' };
  });

  app.delete('/projects/:projectId/shares/:userId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; userId: string };
    context.authz.revokeShare(actor(request), params.projectId, params.userId);
    return { status: 'ok' };
  });

  app.get('/projects/:projectId/authz-matrix', { preHandler: requireSession }, async () => PROJECT_ACTION_MATRIX);

  app.post('/llm/default-backend', { preHandler: requireSession }, async (request) => {
    const body = request.body as BackendSelection;
    context.gateway.setUserDefaultBackend(actor(request), body);
    return { status: 'ok' };
  });

  app.get('/projects/:projectId/llm/backend', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.gateway.resolveBackend(actor(request), params.projectId);
  });

  app.post('/projects/:projectId/llm/backend-override', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    context.gateway.setProjectBackendOverride(actor(request), params.projectId, request.body as BackendSelection);
    return { status: 'ok' };
  });

  app.post('/credentials/admin/:provider', { preHandler: requireSession }, async (request) => {
    const params = request.params as { provider: ProviderId };
    const body = request.body as { secret: string };
    return { id: context.vault.setAdminSharedCredential(actor(request), params.provider, body.secret) };
  });

  app.post('/credentials/self/:provider', { preHandler: requireSession }, async (request) => {
    const params = request.params as { provider: ProviderId };
    const body = request.body as { secret: string };
    return { id: context.vault.setUserOverrideCredential(actor(request), params.provider, body.secret) };
  });

  app.get('/credentials/self', { preHandler: requireSession }, async (request) => context.vault.listSelfCredentials(actor(request)));

  app.get('/projects/:projectId/credentials', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.vault.listProjectCredentials(actor(request), params.projectId);
  });

  app.post('/projects/:projectId/chat', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.gateway.chat(actor(request), params.projectId, request.body as ChatRequest);
  });

  app.post('/projects/:projectId/eln/protocols', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.protocolStore.createProtocol(params.projectId, (request.body as { content: string }).content);
  });

  app.post('/projects/:projectId/eln/protocols/:id/versions', { preHandler: requireSession }, async (request) => {
    const params = request.params as { id: string };
    return context.protocolStore.createProtocolVersion(params.id, (request.body as { content: string }).content);
  });

  app.post('/projects/:projectId/eln/protocols/:id/versions/:versionId/approve', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; versionId: string };
    context.approval.approveProtocolVersion(approvalActor(request), params.projectId, params.versionId);
    return { status: 'ok' };
  });

  app.post('/projects/:projectId/eln/records', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    const body = request.body as RecordFields & { protocolVersionId?: string | null };
    return context.eln.createRecord(actor(request), params.projectId, body, body.protocolVersionId ?? null);
  });

  app.patch('/projects/:projectId/eln/records/:id', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string };
    return context.eln.editRecord(actor(request), params.projectId, params.id, request.body as RecordFields);
  });

  app.get('/projects/:projectId/eln/records/:id', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string };
    return context.eln.getRecordHistory(actor(request), params.projectId, params.id);
  });

  app.post('/projects/:projectId/eln/records/:id/export', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string };
    return context.eln.getRecordHistory(actor(request), params.projectId, params.id);
  });

  app.delete('/projects/:projectId/eln/records/:id', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string };
    context.approval.voidRecord(approvalActor(request), params.projectId, params.id);
    return { status: 'ok' };
  });

  app.get('/projects/:projectId/eln/search', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.eln.search(actor(request), params.projectId, { projectId: params.projectId, ...(request.query as object) });
  });

  app.get('/projects/:projectId/eln/records/:id/provenance', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string };
    return context.eln.getProvenance(actor(request), params.projectId, params.id);
  });

  app.post('/projects/:projectId/eln/records/:id/versions/:versionId/sign', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string; versionId: string };
    const body = request.body as { expectedContentHash: string; meaning: 'reviewed' | 'approved' | 'witnessed'; authorAccountId: string };
    return context.approval.signRecordVersion(
      approvalActor(request),
      params.projectId,
      params.id,
      params.versionId,
      body.expectedContentHash,
      body.meaning,
      body.authorAccountId,
    );
  });

  app.post('/projects/:projectId/eln/records/:id/void', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string };
    context.approval.voidRecord(approvalActor(request), params.projectId, params.id);
    return { status: 'ok' };
  });

  app.get('/projects/:projectId/eln/records/:id/signature-status', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string };
    return context.approval.getSignatureStatus(actor(request), params.projectId, params.id);
  });

  app.get('/projects/:projectId/eln/:subjectType/:subjectVersionId/audit-history', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; subjectType: 'record' | 'protocol'; subjectVersionId: string };
    return context.ledger.getAuditHistory(actor(request), params.projectId, params.subjectType, params.subjectVersionId);
  });

  app.post('/projects/:projectId/audit/integrity/check', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.integrity.runManualIntegrityCheck(actor(request), params.projectId);
  });

  app.post('/projects/:projectId/audit/integrity/clear', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    context.integrity.clearTamperAlert(actor(request), params.projectId);
    return { status: 'ok' };
  });

  app.get('/projects/:projectId/audit/integrity/blocked', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return { blocked: context.integrity.isSigningBlocked(actor(request), params.projectId) };
  });

  app.get('/projects/:projectId/audit/integrity/checkpoint', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.integrity.getChainCheckpoint(actor(request), params.projectId);
  });

  app.get('/projects/:projectId/graphrag/tools', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.graphRag.listTools(actor(request), params.projectId);
  });

  app.post('/projects/:projectId/graphrag/index', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    context.graphRag.enableForProject(params.projectId);
    await context.graphRag.indexDocuments(actor(request), params.projectId, request.body as Array<{ documentId: string; content: string }>);
    return { status: 'ok' };
  });

  app.get('/projects/:projectId/graphrag/stats', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.graphRag.stats(actor(request), params.projectId);
  });

  app.post('/graphrag/query', { preHandler: requireSession }, async (request) => {
    const body = request.body as { projectIds: string[]; question: string };
    return context.graphRag.query(actor(request), body.projectIds, body.question);
  });

  app.post('/projects/:projectId/graphrag/reindex', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    await context.graphRag.reindex(actor(request), params.projectId);
    return { status: 'ok' };
  });

  app.get('/graphrag/embedding-capabilities', { preHandler: requireSession }, async () => context.graphRag.getEmbeddingCapabilities());

  app.get('/projects/:projectId/agent-skills', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.agentConfig.getAgentSkills(actor(request), params.projectId);
  });

  app.post('/projects/:projectId/agent-skills', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    context.agentConfig.setAgentSkills(actor(request), params.projectId, request.body as Array<{ skillId: string; enabled: boolean }>);
    return { status: 'ok' };
  });

  app.get('/projects/:projectId/mcp-servers', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.agentConfig.getMcpServers(actor(request), params.projectId);
  });

  app.post('/projects/:projectId/mcp-servers', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    context.agentConfig.setMcpServers(actor(request), params.projectId, request.body as Array<{ serverId: string; command: string; args: string[]; enabled: boolean }>);
    return { status: 'ok' };
  });

  app.post('/projects/:projectId/agent-skill-sources', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    const body = request.body as { repositoryUrl: string; accessCredentialRef: string };
    return context.agentConfig.registerAgentSkillSource(actor(request), params.projectId, body.repositoryUrl, body.accessCredentialRef);
  });

  app.get('/projects/:projectId/agent-skill-sources/:sourceId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; sourceId: string };
    return context.agentConfig.getAgentSkillSource(actor(request), params.projectId, params.sourceId);
  });

  app.delete('/projects/:projectId/agent-skill-sources/:sourceId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; sourceId: string };
    context.agentConfig.removeAgentSkillSource(actor(request), params.projectId, params.sourceId);
    return { status: 'ok' };
  });

  app.post('/projects/:projectId/agent-skill-sources/:sourceId/preview-sync', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; sourceId: string };
    return context.agentConfig.previewSourceSync(actor(request), params.projectId, params.sourceId, request.body as string[]);
  });

  app.post('/projects/:projectId/agent-skill-sources/:sourceId/sync', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; sourceId: string };
    return context.agentConfig.syncAgentSkillSource(actor(request), params.projectId, params.sourceId, request.body as string[]);
  });

  app.post('/projects/:projectId/mcp-providers/:providerId/enable', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; providerId: string };
    context.agentConfig.enableBuiltinMcpProvider(actor(request), params.projectId, params.providerId);
    return { status: 'ok' };
  });

  return app;
}

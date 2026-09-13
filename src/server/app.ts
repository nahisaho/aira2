import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import {
  authenticate,
  AuthMethodNotImplementedError,
  InvalidCredentialsError,
  KNOWN_AUTH_METHODS,
  listSelectableAuthMethods,
  MfaRequiredError,
  StaleCredentialVersionLoginError,
  type AccountDirectory,
  type AuthMethod,
  type AuthProvider,
} from '../auth/login.js';
import { createAccount, type Account, type Role } from '../auth/account.js';
import type { Session } from '../auth/session-registry.js';
import { SessionRegistry } from '../auth/session-registry.js';
import { AccountSelfService } from '../auth/account-self-service.js';
import { PasswordAuthProvider, hashPassword } from '../auth/password-provider.js';
import { AuditLog } from '../authz/audit.js';
import { PROJECT_ACTION_MATRIX } from '../authz/matrix.js';
import { ProjectAuthorizationService, type ActorContext } from '../authz/project-authz.js';
import { TeamService } from '../authz/team-service.js';
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

const TEST_ONLY_VAULT_KEY = Buffer.alloc(32, 7);
const FRONTEND_DIST_DIR = 'frontend-dist';

export interface EnvConfig {
  port: number;
  dbPath: string;
  sharedCredentials: Partial<Record<ProviderId, string>>;
}

export interface BuildAppOptions extends EnvConfig {
  adapters?: Partial<Record<ProviderId, LlmBackendAdapter>>;
  vaultKey?: Buffer;
  bootstrapAdminUsername?: string;
  bootstrapAdminPassword?: string;
  serveBuiltFrontend?: boolean;
  frontendDistDir?: string;
}

export interface AppContext {
  store: SqliteStore;
  audit: AuditLog;
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
  sessions: SessionRegistry;
  accountSelfService: AccountSelfService;
  teamService: TeamService;
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

function isTestRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'test' || env.VITEST === 'true' || env.VITEST_WORKER_ID !== undefined;
}

/** @id CODE-AIRA2-RUNTIME-004
 * @implements REQ-RUNTIME-005
 * @design DES-AIRA2-011
 */
export function loadVaultKey(env: Record<string, string | undefined> = process.env): Buffer {
  const encoded = env.AIRA2_VAULT_KEY;
  if (!encoded) {
    if (isTestRuntime(env)) {
      return Buffer.from(TEST_ONLY_VAULT_KEY);
    }
    throw new Error('AIRA2_VAULT_KEY must be set to a 64-character hex string before starting the server');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(encoded)) {
    throw new Error('AIRA2_VAULT_KEY must be a 64-character hex string decoding to 32 bytes');
  }
  return Buffer.from(encoded, 'hex');
}

function toHttpStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UnauthenticatedError) return 401;
  if (error instanceof InvalidCredentialsError) return 401;
  if (error instanceof MfaRequiredError) return 401;
  if (error instanceof StaleCredentialVersionLoginError) return 409;
  if (error instanceof AuthMethodNotImplementedError) return 501;
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

function storeBackedAccounts(store: SqliteStore): AccountDirectory {
  return {
    get: (externalIdentity) => store.getAccount<Account>(externalIdentity),
    set: (externalIdentity, account) => {
      store.upsertAccount(externalIdentity, account);
      return account;
    },
  };
}

function buildContext(options: BuildAppOptions): AppContext {
  const store = new SqliteStore({ dbPath: options.dbPath });
  const audit = new AuditLog(store);
  const authz = new ProjectAuthorizationService(audit, { terminateSessionsAndConnections: () => undefined }, store);
  const vault = new CredentialVault(options.vaultKey ?? loadVaultKey(), store);
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
  const sessions = new SessionRegistry(store);
  const accountSelfService = new AccountSelfService(sessions, options.vaultKey ?? loadVaultKey(), audit, store);
  const teamService = new TeamService(
    authz,
    { getVerifiedEmail: (accountId) => accountSelfService.getProfile(accountId)?.verifiedEmail ?? null },
    audit,
    store,
  );
  authz.setTeamShareResolver({
    resolveTeamOnlyRole: (userId, projectId) => teamService.resolveTeamOnlyRole(userId, projectId),
  });
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
  return {
    store,
    audit,
    authz,
    vault,
    gateway,
    ledger,
    protocolStore,
    eln,
    approval,
    integrity,
    agentConfig,
    graphRag,
    sessions,
    accountSelfService,
    teamService,
    systemActor,
    actorForAccount,
  };
}

function bootstrapSharedCredentials(context: AppContext, sharedCredentials: Partial<Record<ProviderId, string>>): void {
  for (const [provider, secret] of Object.entries(sharedCredentials) as Array<[ProviderId, string]>) {
    if (!context.vault.hasAdminSharedCredential(provider)) {
      context.vault.setAdminSharedCredential(context.systemActor, provider, secret);
    }
  }
}

function bootstrapPasswordAdmin(context: AppContext, options: BuildAppOptions): void {
  if (context.store.countPasswordCredentials() > 0) {
    return;
  }
  const username = options.bootstrapAdminUsername ?? process.env.AIRA2_BOOTSTRAP_ADMIN_USERNAME;
  const password = options.bootstrapAdminPassword ?? process.env.AIRA2_BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    if (!isTestRuntime()) {
      console.info('Password bootstrap admin not created because bootstrap credentials were not provided.');
    }
    return;
  }
  context.store.upsertPasswordCredential(username, hashPassword(password));
  const account = createAccount({
    displayName: username,
    externalIdentity: username,
    role: 'admin',
    assignedPersonId: username,
  });
  context.store.upsertAccount(account.id, account);
  ensureAccountSelfServiceRegistered(context, username);
}

/** Idempotently registers an account into DES-AIRA2-014's self-service store the first time it
 * is seen (bootstrap or first login), so subsequent password reads/writes are authoritative
 * there rather than duplicated between it and the legacy `store` password-credential table. */
function ensureAccountSelfServiceRegistered(context: AppContext, accountId: string): void {
  if (context.accountSelfService.getProfile(accountId)) {
    return;
  }
  const account = ensureAccount(context.store, accountId);
  const passwordHash = context.store.getPasswordCredential(accountId) ?? '';
  context.accountSelfService.registerAccount(accountId, account.displayName, null, passwordHash);
}

function authProviders(context: AppContext): AuthProvider[] {
  const reject = (method: 'github-oauth' | 'oidc'): AuthProvider => ({
    method,
    resolveExternalIdentity: () => {
      throw new AuthMethodNotImplementedError(method);
    },
  });
  const passwordLookup = {
    getPasswordCredential: (externalIdentity: string) =>
      context.accountSelfService.getPasswordHash(externalIdentity) ?? context.store.getPasswordCredential(externalIdentity),
  };
  return [new PasswordAuthProvider(passwordLookup), reject('github-oauth'), reject('oidc')];
}

function shouldServeBuiltFrontend(options: BuildAppOptions): boolean {
  return options.serveBuiltFrontend ?? process.env.NODE_ENV === 'production';
}

function frontendArtifacts(options: BuildAppOptions): { rootHtml: string; builtDir: string | null } {
  if (shouldServeBuiltFrontend(options)) {
    const builtDir = resolve(options.frontendDistDir ?? FRONTEND_DIST_DIR);
    const builtIndex = join(builtDir, 'index.html');
    if (!existsSync(builtIndex)) {
      throw new Error(`Built frontend assets not found: ${builtIndex}. Run 'vite build' before starting the server.`);
    }
    return { rootHtml: readFileSync(builtIndex, 'utf8'), builtDir };
  }
  return { rootHtml: readFileSync('index.html', 'utf8'), builtDir: null };
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
  const session = appContext.sessions.validateSession(token);
  if (!session) throw new UnauthenticatedError('Invalid session');
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
  const frontend = frontendArtifacts(options);
  bootstrapSharedCredentials(context, options.sharedCredentials);
  bootstrapPasswordAdmin(context, options);
  app.aira2 = context;

  if (frontend.builtDir) {
    await app.register(fastifyStatic, {
      root: frontend.builtDir,
      prefix: '/',
      wildcard: false,
      decorateReply: false,
      index: false,
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(toHttpStatus(error)).send({ error: message });
  });
  app.addHook('onClose', async () => {
    context.store.close();
  });

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return frontend.rootHtml;
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/auth/methods', async () => listSelectableAuthMethods({ enabledMethods: KNOWN_AUTH_METHODS }));

  app.post('/auth/login/:method', async (request) => {
    const method = (request.params as { method: string }).method;
    const body = (request.body ?? {}) as Record<string, unknown> & { totpCode?: string };
    const mfaCheck = {
      isRequired: (accountId: string) => context.accountSelfService.isMfaRequired(accountId),
      verify: (accountId: string, code: string, now?: number) => context.accountSelfService.verify(accountId, code, now),
    };
    const session = authenticate(
      { enabledMethods: KNOWN_AUTH_METHODS },
      authProviders(context),
      method,
      body,
      storeBackedAccounts(context.store),
      { mfaCheck, sessionIssuer: context.sessions, totpCode: body.totpCode },
    );
    ensureAccountSelfServiceRegistered(context, session.accountId);
    return session;
  });

  app.post('/auth/logout', { preHandler: requireSession }, async (request) => {
    const typed = request as RequestWithActor;
    context.sessions.endSession(typed.aira2Session!.id);
    return { status: 'ok' };
  });

  app.get('/auth/session', { preHandler: requireSession }, async (request) => (request as RequestWithActor).aira2Session);

  // ---- DES-AIRA2-014: Account Profile, Password & MFA Self-Service ----

  app.get('/users/me/profile', { preHandler: requireSession }, async (request) => context.accountSelfService.getProfile(actor(request).accountId));

  app.patch('/users/me/profile', { preHandler: requireSession }, async (request) => {
    const body = request.body as { displayName?: string; email?: string };
    return context.accountSelfService.updateProfile(actor(request), body);
  });

  app.post('/users/me/email/confirm/:token', async (request) => {
    const params = request.params as { token: string };
    return context.accountSelfService.confirmEmailChange(params.token);
  });

  app.post('/users/me/password', { preHandler: requireSession }, async (request) => {
    const body = request.body as { currentPassword: string; newPassword: string };
    const result = context.accountSelfService.changePassword(actor(request), body.currentPassword, body.newPassword);
    if (result.status === 'ok') {
      const newHash = context.accountSelfService.getPasswordHash(actor(request).accountId);
      if (newHash) context.store.upsertPasswordCredential(actor(request).accountId, newHash);
    }
    return result;
  });

  app.post('/password-reset/request', async (request) => {
    const body = request.body as { email: string };
    return context.accountSelfService.requestPasswordReset(body.email);
  });

  app.post('/password-reset/:token/complete', async (request) => {
    const params = request.params as { token: string };
    const body = request.body as { newPassword: string };
    const result = context.accountSelfService.completePasswordReset(params.token, body.newPassword);
    if (result.status === 'ok') {
      const newHash = context.accountSelfService.getPasswordHash(result.accountId);
      if (newHash) context.store.upsertPasswordCredential(result.accountId, newHash);
    }
    return result;
  });

  app.post('/users/me/mfa/totp/enroll', { preHandler: requireSession }, async (request) => context.accountSelfService.enrollTotp(actor(request)));

  app.post('/users/me/mfa/totp/confirm', { preHandler: requireSession }, async (request) => {
    const body = request.body as { code: string };
    const confirmed = context.accountSelfService.confirmTotpEnrollment(actor(request).accountId, body.code);
    return { status: confirmed ? 'ok' : 'invalid' };
  });

  // ---- DES-AIRA2-015: Session Registry self-service listing/revocation ----

  app.get('/users/me/sessions', { preHandler: requireSession }, async (request) => context.sessions.listSessions(actor(request).accountId));

  app.delete('/users/me/sessions/:displayId', { preHandler: requireSession }, async (request) => {
    const typed = request as RequestWithActor;
    const params = request.params as { displayId: string };
    const accountId = actor(request).accountId;
    const revoked = context.sessions.revokeSession(accountId, params.displayId, typed.aira2Session!.id);
    if (revoked) {
      context.audit.record({
        userId: accountId,
        timestamp: Date.now(),
        actionType: 'session.revoke',
        targetResource: `account:${accountId}:session:${params.displayId}`,
      });
    }
    return { status: revoked ? 'ok' : 'not-found' };
  });

  // ---- DES-AIRA2-013: Invitation & Team Management Service ----

  app.post('/projects/:projectId/invitations', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    const body = request.body as { email: string; role: 'viewer' | 'editor' };
    return context.teamService.createInvitation(actor(request), params.projectId, body.email, body.role);
  });

  app.post('/invitations/:token/accept', { preHandler: requireSession }, async (request) => {
    const params = request.params as { token: string };
    return context.teamService.acceptInvitation(params.token, actor(request).accountId);
  });

  app.delete('/projects/:projectId/invitations/:invitationId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; invitationId: string };
    context.teamService.cancelInvitation(actor(request), params.projectId, params.invitationId);
    return { status: 'ok' };
  });

  app.get('/projects/:projectId/members', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    return context.teamService.listMembers(actor(request), params.projectId);
  });

  app.patch('/projects/:projectId/members/:userId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; userId: string };
    const body = request.body as { role: 'viewer' | 'editor' };
    context.teamService.changeMemberRole(actor(request), params.projectId, params.userId, body.role);
    return { status: 'ok' };
  });

  app.delete('/projects/:projectId/members/:userId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; userId: string };
    context.teamService.removeMember(actor(request), params.projectId, params.userId);
    return { status: 'ok' };
  });

  app.post('/teams', { preHandler: requireSession }, async (request) => {
    const body = request.body as { name: string };
    return context.teamService.createTeam(actor(request), body.name);
  });

  app.patch('/teams/:teamId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { teamId: string };
    const body = request.body as { admin: string };
    context.teamService.assignTeamAdmin(actor(request), params.teamId, body.admin);
    return { status: 'ok' };
  });

  app.delete('/teams/:teamId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { teamId: string };
    context.teamService.deleteTeam(actor(request), params.teamId);
    return { status: 'ok' };
  });

  app.post('/teams/:teamId/members', { preHandler: requireSession }, async (request) => {
    const params = request.params as { teamId: string };
    const body = request.body as { userId: string };
    context.teamService.addTeamMember(actor(request), params.teamId, body.userId);
    return { status: 'ok' };
  });

  app.delete('/teams/:teamId/members/:userId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { teamId: string; userId: string };
    context.teamService.removeTeamMember(actor(request), params.teamId, params.userId);
    return { status: 'ok' };
  });

  app.post('/projects/:projectId/team-shares', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string };
    const body = request.body as { teamId: string; role: 'viewer' | 'editor' };
    context.teamService.grantTeamShare(actor(request), params.projectId, body.teamId, body.role);
    return { status: 'ok' };
  });

  app.delete('/projects/:projectId/team-shares/:teamId', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; teamId: string };
    context.teamService.revokeTeamShare(actor(request), params.projectId, params.teamId);
    return { status: 'ok' };
  });

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
    return context.eln.createProtocol(actor(request), params.projectId, (request.body as { content: string }).content);
  });

  app.post('/projects/:projectId/eln/protocols/:id/versions', { preHandler: requireSession }, async (request) => {
    const params = request.params as { projectId: string; id: string };
    return context.eln.createProtocolVersion(
      actor(request),
      params.projectId,
      params.id,
      (request.body as { content: string }).content,
    );
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
    return context.eln.exportRecordHistory(actor(request), params.projectId, params.id);
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

  app.get('/*', async (request, reply) => {
    const path = (request.params as { '*': string })['*'] ?? '';
    if (path.startsWith('web/')) {
      reply.status(404);
      return { error: 'Not found' };
    }
    if (extname(path)) {
      reply.status(404);
      return { error: 'Not found' };
    }
    reply.type('text/html; charset=utf-8');
    return frontend.rootHtml;
  });

  return app;
}

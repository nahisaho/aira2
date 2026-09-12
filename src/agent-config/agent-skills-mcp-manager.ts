import type { ProjectAuthorizationService, ActorContext } from '../authz/project-authz.js';
import { AuthorizationDeniedError } from '../authz/project-authz.js';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../server/store.js';

export interface AgentSkillConfig {
  skillId: string;
  enabled: boolean;
}

export interface McpServerConfig {
  serverId: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface AgentSkillSource {
  sourceId: string;
  repositoryUrl: string;
  accessCredentialRef: string;
  availableSkillIds: string[];
}

export interface SkillSourceDiff {
  sourceId: string;
  added: string[];
  removed: string[];
}

function requireAuthorized(
  authz: ProjectAuthorizationService,
  actor: ActorContext,
  projectId: string,
  action: string,
): void {
  if (!authz.authorize(actor, projectId, action)) {
    throw new AuthorizationDeniedError(action);
  }
}

/** @id CODE-AIRA2-AGENTCFG-001
 * @implements REQ-AGENTCONFIG-001 REQ-AGENTCONFIG-002 REQ-AGENTCONFIG-003
 * @design DES-AIRA2-008
 * Per-project Agent Skills and MCP server configuration, using the same
 * file/config layout and per-project isolation model as AIRA. A sync only
 * ever applies via `syncAgentSkillSource`; `previewSourceSync` computes the
 * same diff without mutating stored state, so a caller can review before
 * confirming (never silently overwriting local edits).
 */
export class AgentSkillsMcpConfigManager {
  constructor(
    private readonly authz: ProjectAuthorizationService,
    private readonly store: SqliteStore = new SqliteStore({ dbPath: ':memory:' }),
  ) {}

  private requireAuthorized(actor: ActorContext, projectId: string, action: string): void {
    requireAuthorized(this.authz, actor, projectId, action);
  }

  private requireOwnedSource(projectId: string, sourceId: string): AgentSkillSource {
    const projectSources = this.store.listAgentSkillSources(projectId);
    if (!projectSources.includes(sourceId)) {
      throw new Error(`Unknown agent skill source for project: ${sourceId}`);
    }
    const source = this.store.getAgentSkillSource(sourceId);
    if (!source) {
      throw new Error(`Unknown agent skill source: ${sourceId}`);
    }
    return source;
  }

  getAgentSkills(actor: ActorContext, projectId: string): AgentSkillConfig[] {
    this.requireAuthorized(actor, projectId, 'agent-skills.view');
    return this.store.getAgentSkills(projectId);
  }

  setAgentSkills(actor: ActorContext, projectId: string, skills: AgentSkillConfig[]): void {
    this.requireAuthorized(actor, projectId, 'agent-skills.modify');
    this.store.replaceAgentSkills(projectId, skills);
  }

  getMcpServers(actor: ActorContext, projectId: string): McpServerConfig[] {
    this.requireAuthorized(actor, projectId, 'mcp-config.view');
    return this.store.getMcpServers(projectId);
  }

  setMcpServers(actor: ActorContext, projectId: string, servers: McpServerConfig[]): void {
    this.requireAuthorized(actor, projectId, 'mcp-config.modify');
    this.store.replaceMcpServers(projectId, servers);
  }

  registerAgentSkillSource(
    actor: ActorContext,
    projectId: string,
    repositoryUrl: string,
    accessCredentialRef: string,
  ): AgentSkillSource {
    this.requireAuthorized(actor, projectId, 'agent-skill-source.manage');
    const source: AgentSkillSource = {
      sourceId: `agent-skill-source-${randomUUID()}`,
      repositoryUrl,
      accessCredentialRef,
      availableSkillIds: [],
    };
    this.store.putAgentSkillSource({ ...source, projectId });
    return source;
  }

  getAgentSkillSource(actor: ActorContext, projectId: string, sourceId: string): AgentSkillSource {
    this.requireAuthorized(actor, projectId, 'agent-skills.view');
    return this.requireOwnedSource(projectId, sourceId);
  }

  removeAgentSkillSource(actor: ActorContext, projectId: string, sourceId: string): void {
    this.requireAuthorized(actor, projectId, 'agent-skill-source.manage');
    this.requireOwnedSource(projectId, sourceId);
    this.store.deleteAgentSkillSource(sourceId);
  }

  private computeDiff(sourceId: string, projectId: string, latestSkillIds: string[]): SkillSourceDiff {
    const source = this.requireOwnedSource(projectId, sourceId);
    const current = new Set(source.availableSkillIds);
    const latest = new Set(latestSkillIds);
    return {
      sourceId,
      added: latestSkillIds.filter((id) => !current.has(id)),
      removed: source.availableSkillIds.filter((id) => !latest.has(id)),
    };
  }

  previewSourceSync(
    actor: ActorContext,
    projectId: string,
    sourceId: string,
    latestSkillIds: string[],
  ): SkillSourceDiff {
    this.requireAuthorized(actor, projectId, 'agent-skill-source.sync');
    return this.computeDiff(sourceId, projectId, latestSkillIds);
  }

  syncAgentSkillSource(
    actor: ActorContext,
    projectId: string,
    sourceId: string,
    latestSkillIds: string[],
  ): SkillSourceDiff {
    this.requireAuthorized(actor, projectId, 'agent-skill-source.sync');
    const diff = this.computeDiff(sourceId, projectId, latestSkillIds);
    const source = this.requireOwnedSource(projectId, sourceId);
    this.store.putAgentSkillSource({ ...source, projectId, availableSkillIds: latestSkillIds });
    return diff;
  }

  enableBuiltinMcpProvider(actor: ActorContext, projectId: string, providerId: string): void {
    this.requireAuthorized(actor, projectId, 'mcp-provider.enable');
    const servers = this.store.getMcpServers(projectId);
    const existing = servers.find((s) => s.serverId === providerId);
    if (existing) {
      existing.enabled = true;
    } else {
      servers.push({ serverId: providerId, command: 'builtin', args: [providerId], enabled: true });
    }
    this.store.replaceMcpServers(projectId, servers);
  }
}

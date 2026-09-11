import { describe, expect, it } from 'vitest';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';
import { AgentSkillsMcpConfigManager } from './agent-skills-mcp-manager.js';

function setup() {
  const authz = new ProjectAuthorizationService(new AuditLog(), {
    terminateSessionsAndConnections: () => undefined,
  });
  authz.createProject('owner-1', 'project-a');
  authz.createProject('owner-1', 'project-b');
  const manager = new AgentSkillsMcpConfigManager(authz);
  return { authz, manager };
}

/** @id TEST-AIRA2-AGENTCFG-001
 * @verifies REQ-AGENTCONFIG-001
 */
describe('per-project Agent Skills management', () => {
  it('TEST-AIRA2-AGENTCFG-001 enables a skill in one project without affecting the same user\'s other project', () => {
    const { manager } = setup();
    const actor = { accountId: 'owner-1' };

    manager.setAgentSkills(actor, 'project-a', [{ skillId: 'skill-x', enabled: true }]);

    expect(manager.getAgentSkills(actor, 'project-a')).toEqual([{ skillId: 'skill-x', enabled: true }]);
    expect(manager.getAgentSkills(actor, 'project-b')).toEqual([]);

    manager.setAgentSkills(actor, 'project-b', [{ skillId: 'skill-x', enabled: false }]);
    expect(manager.getAgentSkills(actor, 'project-b')).toEqual([{ skillId: 'skill-x', enabled: false }]);
    expect(manager.getAgentSkills(actor, 'project-a')).toEqual([{ skillId: 'skill-x', enabled: true }]);

    expect(() =>
      manager.setAgentSkills({ accountId: 'stranger' }, 'project-a', [{ skillId: 'skill-y', enabled: true }]),
    ).toThrow();
  });
});

/** @id TEST-AIRA2-AGENTCFG-002
 * @verifies REQ-AGENTCONFIG-002
 */
describe('per-project MCP server configuration', () => {
  it('TEST-AIRA2-AGENTCFG-002 adds and enables an MCP server configuration in one project with no effect on another', () => {
    const { manager } = setup();
    const actor = { accountId: 'owner-1' };
    const config = { serverId: 'server-1', command: 'node', args: ['server.js'], enabled: true };

    manager.setMcpServers(actor, 'project-a', [config]);

    expect(manager.getMcpServers(actor, 'project-a')).toEqual([config]);
    expect(manager.getMcpServers(actor, 'project-b')).toEqual([]);
  });
});

/** @id TEST-AIRA2-AGENTCFG-003
 * @verifies REQ-AGENTCONFIG-003
 */
describe('external Agent Skills repository sync', () => {
  it('TEST-AIRA2-AGENTCFG-003 registers an external repository, previews then applies a sync diff, and makes its skills available for assignment', () => {
    const { manager } = setup();
    const actor = { accountId: 'owner-1' };

    const source = manager.registerAgentSkillSource(actor, 'project-a', 'https://github.com/org/skills', 'cred-ref-1');
    expect(source.repositoryUrl).toBe('https://github.com/org/skills');
    expect(manager.getAgentSkillSource(actor, 'project-a', source.sourceId).availableSkillIds).toEqual([]);

    const diff = manager.previewSourceSync(actor, 'project-a', source.sourceId, ['skill-alpha', 'skill-beta']);
    expect(diff.added).toEqual(['skill-alpha', 'skill-beta']);
    expect(diff.removed).toEqual([]);
    // Preview alone must not silently apply the change.
    expect(manager.getAgentSkillSource(actor, 'project-a', source.sourceId).availableSkillIds).toEqual([]);

    const applied = manager.syncAgentSkillSource(actor, 'project-a', source.sourceId, ['skill-alpha', 'skill-beta']);
    expect(applied.added).toEqual(['skill-alpha', 'skill-beta']);
    expect(manager.getAgentSkillSource(actor, 'project-a', source.sourceId).availableSkillIds).toEqual([
      'skill-alpha',
      'skill-beta',
    ]);

    manager.setAgentSkills(actor, 'project-a', [{ skillId: 'skill-alpha', enabled: true }]);
    expect(manager.getAgentSkills(actor, 'project-a')).toEqual([{ skillId: 'skill-alpha', enabled: true }]);
  });
});

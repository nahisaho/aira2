export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** @id CODE-AIRA2-AUTHZ-001
 * @implements REQ-MULTIUSER-009
 * @design DES-AIRA2-002
 * Concrete project-scoped authorization matrix. This is the single source of
 * truth mirrored in .musubix/features/aira2-platform/design.md (DES-AIRA2-002).
 * Every row must define all three roles explicitly — no action may leave a
 * role undefined (REQ-MULTIUSER-009).
 */
export const PROJECT_ACTION_MATRIX: Readonly<Record<string, Readonly<Record<ProjectRole, boolean>>>> = {
  'project.share.manage': { owner: true, editor: false, viewer: false },
  'eln.view': { owner: true, editor: true, viewer: true },
  'eln.create': { owner: true, editor: true, viewer: false },
  'eln.edit': { owner: true, editor: true, viewer: false },
  'eln.approve': { owner: true, editor: false, viewer: false },
  'eln.sign': { owner: true, editor: true, viewer: false },
  'eln.void': { owner: true, editor: false, viewer: false },
  'eln.export': { owner: true, editor: true, viewer: false },
  'eln.audit-history.view': { owner: true, editor: true, viewer: false },
  'eln.audit-integrity.manage': { owner: true, editor: false, viewer: false },
  'eln.audit-integrity.view': { owner: true, editor: true, viewer: false },
  'graphrag.view': { owner: true, editor: true, viewer: true },
  'graphrag.create': { owner: true, editor: true, viewer: false },
  'graphrag.modify': { owner: true, editor: false, viewer: false },
  'llmbackend.project-override.view': { owner: true, editor: true, viewer: true },
  'llmbackend.project-override.modify': { owner: true, editor: false, viewer: false },
  'credential.project.use': { owner: true, editor: true, viewer: false },
  'credential.project.view': { owner: true, editor: false, viewer: false },
  'agent-skills.view': { owner: true, editor: true, viewer: true },
  'agent-skills.modify': { owner: true, editor: true, viewer: false },
  'mcp-config.view': { owner: true, editor: true, viewer: true },
  'mcp-config.modify': { owner: true, editor: true, viewer: false },
  'agent-skill-source.manage': { owner: true, editor: true, viewer: false },
  'agent-skill-source.sync': { owner: true, editor: true, viewer: false },
  'mcp-provider.enable': { owner: true, editor: true, viewer: false },
};

export const ELN_AND_GRAPHRAG_ACTIONS = [
  'eln.view',
  'eln.create',
  'eln.edit',
  'eln.approve',
  'eln.sign',
  'eln.void',
  'eln.export',
  'eln.audit-history.view',
  'graphrag.view',
  'graphrag.create',
  'graphrag.modify',
] as const;

export function isProjectActionAllowed(role: ProjectRole | undefined, action: string): boolean {
  if (!role) return false;
  const cell = PROJECT_ACTION_MATRIX[action];
  if (!cell) return false;
  return cell[role];
}

/** Self-scope actions: policy owned by DES-AIRA2-002, no project role involved. */
export const SELF_SCOPE_ACTIONS = [
  'llmbackend.user-default.modify',
  'credential.user-override.modify',
  'credential.self.view',
  'llmbackend.admin-credential.modify',
  'account.service-account.modify',
] as const;
export type SelfScopeAction = (typeof SELF_SCOPE_ACTIONS)[number];

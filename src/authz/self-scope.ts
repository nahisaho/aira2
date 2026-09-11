export const SELF_SCOPE_ACTIONS = [
  'llmbackend.user-default.modify',
  'credential.user-override.modify',
  'credential.self.view',
  'llmbackend.admin-credential.modify',
  'account.service-account.modify',
] as const;
export type SelfScopeAction = (typeof SELF_SCOPE_ACTIONS)[number];

export interface SelfScopeActorContext {
  accountId: string;
  isGlobalAdmin: boolean;
}

type SelfScopePolicy = 'any-authenticated-user' | 'global-admin-only';

/**
 * Self-scope matrix policy, owned by DES-AIRA2-002 (mirrors design.md).
 * `llmbackend.admin-credential.modify` gates DES-AIRA2-003's admin shared
 * credential writes (REQ-LLMBACKEND-003); `credential.user-override.modify`
 * gates per-user credential overrides (REQ-LLMBACKEND-004).
 */
const SELF_SCOPE_POLICY: Readonly<Record<SelfScopeAction, SelfScopePolicy>> = {
  'llmbackend.user-default.modify': 'any-authenticated-user',
  'credential.user-override.modify': 'any-authenticated-user',
  'credential.self.view': 'any-authenticated-user',
  'llmbackend.admin-credential.modify': 'global-admin-only',
  'account.service-account.modify': 'global-admin-only',
};

/** @id CODE-AIRA2-AUTHZ-004
 * @implements REQ-LLMBACKEND-003
 * @design DES-AIRA2-002
 */
export function authorizeSelf(actor: SelfScopeActorContext, action: SelfScopeAction): boolean {
  const policy = SELF_SCOPE_POLICY[action];
  if (policy === 'global-admin-only') {
    return actor.isGlobalAdmin;
  }
  return true;
}

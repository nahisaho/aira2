export const SELF_SCOPE_ACTIONS = [
  'llmbackend.user-default.modify',
  'credential.user-override.modify',
  'credential.self.view',
  'llmbackend.admin-credential.modify',
  'account.service-account.modify',
  'profile.self.update',
  'password.self.change',
  'mfa.self.enroll',
  'session.self.list',
  'session.self.revoke',
  'team.create',
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
 * `profile.self.update`/`password.self.change`/`mfa.self.enroll` are enforced
 * here on behalf of DES-AIRA2-014 (REQ-MULTIUSER-018/019/021);
 * `session.self.list`/`session.self.revoke` are enforced here on behalf of
 * DES-AIRA2-015 (REQ-MULTIUSER-023/024); `team.create` is enforced here on
 * behalf of DES-AIRA2-013 (REQ-MULTIUSER-016/030).
 */
const SELF_SCOPE_POLICY: Readonly<Record<SelfScopeAction, SelfScopePolicy>> = {
  'llmbackend.user-default.modify': 'any-authenticated-user',
  'credential.user-override.modify': 'any-authenticated-user',
  'credential.self.view': 'any-authenticated-user',
  'llmbackend.admin-credential.modify': 'global-admin-only',
  'account.service-account.modify': 'global-admin-only',
  'profile.self.update': 'any-authenticated-user',
  'password.self.change': 'any-authenticated-user',
  'mfa.self.enroll': 'any-authenticated-user',
  'session.self.list': 'any-authenticated-user',
  'session.self.revoke': 'any-authenticated-user',
  'team.create': 'global-admin-only',
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

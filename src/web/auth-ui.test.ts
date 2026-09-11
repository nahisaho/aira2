import { describe, expect, it } from 'vitest';
import { AuthUiController } from './auth-ui.js';
import type { Account } from '../auth/account.js';
import { createAccount } from '../auth/account.js';
import type { AuthProvider, DeploymentAuthConfig } from '../auth/login.js';
import { DesignSystemRegistry } from './design-system.js';

function setup() {
  const config: DeploymentAuthConfig = { enabledMethods: ['password'] };
  const accounts = new Map<string, Account>();
  accounts.set('admin-1', createAccount({ displayName: 'Admin One', externalIdentity: 'admin-1', role: 'admin' }));
  accounts.set('member-1', createAccount({ displayName: 'Member One', externalIdentity: 'member-1', role: 'member' }));
  const provider: AuthProvider = {
    method: 'password',
    resolveExternalIdentity: (credentials) => (credentials as { accountId: string }).accountId,
  };
  const registry = new DesignSystemRegistry();
  const controller = new AuthUiController(config, [provider], accounts, registry);
  return { controller, registry };
}

/** @id TEST-AIRA2-GUI-001
 * @verifies REQ-GUI-001
 */
describe('authentication and account UI', () => {
  it('TEST-AIRA2-GUI-001 reflects each session\'s identity and role-gated admin controls across two sequential logins', () => {
    const { controller } = setup();

    const adminState = controller.login('password', { accountId: 'admin-1' });
    expect(adminState.displayName).toBe('Admin One');
    expect(adminState.role).toBe('admin');
    expect(adminState.adminControlsVisible).toBe(true);

    controller.logout();
    expect(controller.currentUser()).toBeNull();

    const memberState = controller.login('password', { accountId: 'member-1' });
    expect(memberState.displayName).toBe('Member One');
    expect(memberState.role).toBe('member');
    expect(memberState.adminControlsVisible).toBe(false);
    expect(controller.currentUser()).toEqual(memberState);
  });
});

import { authenticate, type AuthProvider, type DeploymentAuthConfig } from '../auth/login.js';
import type { Account } from '../auth/account.js';
import { isAdmin } from '../auth/account.js';
import type { Session } from '../auth/session.js';
import { DesignSystemRegistry } from './design-system.js';

export interface AuthUiState {
  session: Session;
  displayName: string;
  role: Account['role'];
  /** Admin-only controls (e.g. deployment-wide auth-method configuration) are only visible when true. */
  adminControlsVisible: boolean;
}

/** @id CODE-AIRA2-GUI-002
 * @implements REQ-GUI-001
 * @design DES-AIRA2-010
 * View-model layer for the login/logout/account-switcher UI: renders the
 * authenticated user's identity and gates admin-only controls strictly on
 * that user's role, per DES-AIRA2-002's authorization matrix constraint.
 */
export class AuthUiController {
  private currentState: AuthUiState | null = null;

  constructor(
    private readonly config: DeploymentAuthConfig,
    private readonly providers: AuthProvider[],
    private readonly accounts: Map<string, Account>,
    registry: DesignSystemRegistry = new DesignSystemRegistry(),
  ) {
    registry.register('chat');
  }

  login(method: string, credentials: unknown): AuthUiState {
    const session = authenticate(this.config, this.providers, method, credentials, this.accounts);
    const account = this.accounts.get(session.accountId);
    if (!account) {
      throw new Error(`No account found for session: ${session.accountId}`);
    }
    this.currentState = {
      session,
      displayName: account.displayName,
      role: account.role,
      adminControlsVisible: isAdmin(account),
    };
    return this.currentState;
  }

  logout(): void {
    this.currentState = null;
  }

  currentUser(): AuthUiState | null {
    return this.currentState;
  }
}

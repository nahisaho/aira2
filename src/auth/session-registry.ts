import { randomBytes } from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  id: string;
  accountId: string;
  credentialVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionListing {
  displayId: string;
  createdAt: number;
  expiresAt: number;
}

export type IssueOutcome = Session | { status: 'stale-version' } | { status: 'mfa-required' };

/**
 * @id CODE-AIRA2-SESSION-001
 * @implements REQ-MULTIUSER-046 REQ-MULTIUSER-047 REQ-MULTIUSER-048 REQ-MULTIUSER-050 REQ-MULTIUSER-023 REQ-MULTIUSER-024
 * @design DES-AIRA2-015
 */
export class SessionRegistry {
  private readonly credentialVersions = new Map<string, number>();
  private readonly sessions = new Map<string, Session>();
  private readonly displayIds = new Map<string, string>();

  getCredentialVersion(accountId: string): number {
    return this.credentialVersions.get(accountId) ?? 0;
  }

  incrementCredentialVersion(accountId: string): number {
    const next = this.getCredentialVersion(accountId) + 1;
    this.credentialVersions.set(accountId, next);
    return next;
  }

  issueSession(accountId: string, now: number = Date.now(), ttlMs: number = DEFAULT_SESSION_TTL_MS): Session {
    const credentialVersion = this.getCredentialVersion(accountId);
    return this.recordSession(accountId, credentialVersion, now, ttlMs);
  }

  issueSessionIfEligible(
    accountId: string,
    versionAtVerification: number,
    mfaSatisfied: boolean,
    now: number = Date.now(),
    ttlMs: number = DEFAULT_SESSION_TTL_MS,
  ): IssueOutcome {
    const currentVersion = this.getCredentialVersion(accountId);
    if (currentVersion !== versionAtVerification) {
      return { status: 'stale-version' };
    }
    if (!mfaSatisfied) {
      return { status: 'mfa-required' };
    }
    return this.recordSession(accountId, currentVersion, now, ttlMs);
  }

  validateSession(sessionId: string, now: number = Date.now()): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (session.expiresAt <= now) {
      return null;
    }
    if (session.credentialVersion !== this.getCredentialVersion(session.accountId)) {
      return null;
    }
    return session;
  }

  getDisplayId(sessionId: string): string | undefined {
    return this.displayIds.get(sessionId);
  }

  listSessions(accountId: string, now: number = Date.now()): SessionListing[] {
    const result: SessionListing[] = [];
    for (const session of this.sessions.values()) {
      if (session.accountId !== accountId) continue;
      if (session.expiresAt <= now) continue;
      if (session.credentialVersion !== this.getCredentialVersion(accountId)) continue;
      result.push({
        displayId: this.displayIds.get(session.id)!,
        createdAt: session.issuedAt,
        expiresAt: session.expiresAt,
      });
    }
    return result;
  }

  revokeSession(accountId: string, displayId: string, currentSessionId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.accountId !== accountId) continue;
      if (this.displayIds.get(session.id) !== displayId) continue;
      if (session.id === currentSessionId) {
        return false;
      }
      this.sessions.delete(session.id);
      this.displayIds.delete(session.id);
      return true;
    }
    return false;
  }

  /**
   * Composition-root-only: unconditionally ends a session, including the caller's own current
   * session. Used exclusively by DES-AIRA2-012's `/auth/logout` route, which is distinct from
   * the self-service `revokeSession` action (that action intentionally rejects targeting the
   * caller's own current session; see REQ-MULTIUSER-024).
   */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.displayIds.delete(sessionId);
  }

  private recordSession(accountId: string, credentialVersion: number, now: number, ttlMs: number): Session {
    const session: Session = {
      id: randomBytes(32).toString('hex'),
      accountId,
      credentialVersion,
      issuedAt: now,
      expiresAt: now + ttlMs,
    };
    this.sessions.set(session.id, session);
    this.displayIds.set(session.id, randomBytes(8).toString('hex'));
    return session;
  }
}

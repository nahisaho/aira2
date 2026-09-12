import { createHmac, randomBytes } from 'node:crypto';
import { hashPassword, verifyPasswordHash } from './password-provider.js';
import type { Session } from './session-registry.js';
import { SessionRegistry } from './session-registry.js';
import { authorizeSelf, type SelfScopeActorContext } from '../authz/self-scope.js';
import { decryptSecret, encryptSecret, type EncryptedPayload } from '../vault/crypto.js';

const EMAIL_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RESET_RATE_LIMIT_MAX_REQUESTS = 3;
const TOTP_STEP_MS = 30_000;
const TOTP_DIGITS = 6;
const MFA_FAILURE_LOCKOUT_THRESHOLD = 5;
const MFA_LOCKOUT_COOLDOWN_MS = 5 * 60 * 1000;

export interface ProfileRecord {
  accountId: string;
  displayName: string;
  verifiedEmail: string | null;
}

interface PendingEmailChange {
  token: string;
  accountId: string;
  newEmail: string;
  expiresAt: number;
}

interface ResetToken {
  token: string;
  accountId: string;
  expiresAt: number;
  consumed: boolean;
}

interface TotpFactor {
  encryptedSecret: EncryptedPayload;
  active: boolean;
  acceptedSteps: Set<number>;
  consecutiveFailures: number;
  lockedUntil: number;
}

export type ProfileUpdatePatch = Partial<Record<string, unknown>>;

export class AccountAuthorizationDeniedError extends Error {
  constructor(action: string) {
    super(`self-scope action denied: ${action}`);
    this.name = 'AccountAuthorizationDeniedError';
  }
}

export type ChangePasswordResult = { status: 'ok'; session: Session } | { status: 'invalid-current-password' };

export type CompleteResetResult = { status: 'ok'; accountId: string } | { status: 'invalid-token' };

export type ConfirmEmailResult = { status: 'ok' } | { status: 'invalid-token' } | { status: 'email-in-use' };

export type MfaVerifyResult = 'valid' | 'invalid' | 'locked';

/**
 * @id CODE-AIRA2-ACCOUNT-SELF-001
 * @implements REQ-MULTIUSER-018 REQ-MULTIUSER-019 REQ-MULTIUSER-020 REQ-MULTIUSER-021
 *   REQ-MULTIUSER-027 REQ-MULTIUSER-028 REQ-MULTIUSER-032 REQ-MULTIUSER-033
 *   REQ-MULTIUSER-034 REQ-MULTIUSER-036 REQ-MULTIUSER-037 REQ-MULTIUSER-038
 *   REQ-MULTIUSER-040 REQ-MULTIUSER-041 REQ-MULTIUSER-042 REQ-MULTIUSER-043
 *   REQ-MULTIUSER-044 REQ-MULTIUSER-049
 * @design DES-AIRA2-014
 */
export class AccountSelfService {
  private readonly profiles = new Map<string, ProfileRecord>();
  private readonly passwordHashes = new Map<string, string>();
  private readonly pendingEmailChanges = new Map<string, PendingEmailChange>();
  private readonly resetTokens = new Map<string, ResetToken>();
  private readonly resetRequestLog = new Map<string, number[]>();
  private readonly totpFactors = new Map<string, TotpFactor>();
  private readonly deliveredLinks: { accountId: string; email: string; token: string }[] = [];

  constructor(
    private readonly sessions: SessionRegistry,
    private readonly encryptionKey: Buffer,
  ) {}

  registerAccount(accountId: string, displayName: string, verifiedEmail: string | null, passwordHash: string): void {
    this.profiles.set(accountId, { accountId, displayName, verifiedEmail });
    this.passwordHashes.set(accountId, passwordHash);
  }

  /** Composition-root-only accessor letting DES-AIRA2-012 keep a legacy password-credential
   * store in sync/absent after this service becomes the authoritative source for an account. */
  getPasswordHash(accountId: string): string | undefined {
    return this.passwordHashes.get(accountId);
  }

  getProfile(accountId: string): ProfileRecord | undefined {
    return this.profiles.get(accountId);
  }

  getDeliveredLinks(): readonly { accountId: string; email: string; token: string }[] {
    return this.deliveredLinks;
  }

  updateProfile(actor: SelfScopeActorContext, patch: ProfileUpdatePatch, now: number = Date.now()): ProfileRecord {
    if (!authorizeSelf(actor, 'profile.self.update')) {
      throw new AccountAuthorizationDeniedError('profile.self.update');
    }
    const profile = this.requireProfile(actor.accountId);
    if (typeof patch.displayName === 'string') {
      profile.displayName = patch.displayName;
    }
    if (typeof patch.email === 'string' && patch.email !== profile.verifiedEmail) {
      this.beginEmailChange(actor.accountId, patch.email, now);
    }
    // role/accountId (or any other field) submitted in patch is silently ignored: only
    // displayName/email are ever applied above.
    return { ...profile };
  }

  private beginEmailChange(accountId: string, newEmail: string, now: number): void {
    const token = randomBytes(24).toString('hex');
    this.pendingEmailChanges.set(token, {
      token,
      accountId,
      newEmail,
      expiresAt: now + EMAIL_CONFIRMATION_TTL_MS,
    });
    this.deliveredLinks.push({ accountId, email: newEmail, token });
  }

  confirmEmailChange(token: string, now: number = Date.now()): ConfirmEmailResult {
    const pending = this.pendingEmailChanges.get(token);
    if (!pending || pending.expiresAt <= now) {
      return { status: 'invalid-token' };
    }
    const alreadyVerifiedElsewhere = [...this.profiles.values()].some(
      (candidate) => candidate.accountId !== pending.accountId && candidate.verifiedEmail === pending.newEmail,
    );
    if (alreadyVerifiedElsewhere) {
      this.pendingEmailChanges.delete(token);
      return { status: 'email-in-use' };
    }
    const profile = this.requireProfile(pending.accountId);
    profile.verifiedEmail = pending.newEmail;
    this.pendingEmailChanges.delete(token);
    return { status: 'ok' };
  }

  changePassword(
    actor: SelfScopeActorContext,
    currentPassword: string,
    newPassword: string,
    now: number = Date.now(),
  ): ChangePasswordResult {
    if (!authorizeSelf(actor, 'password.self.change')) {
      throw new AccountAuthorizationDeniedError('password.self.change');
    }
    const storedHash = this.passwordHashes.get(actor.accountId);
    if (!storedHash || !verifyPasswordHash(currentPassword, storedHash)) {
      return { status: 'invalid-current-password' };
    }
    this.passwordHashes.set(actor.accountId, hashPassword(newPassword));
    this.sessions.incrementCredentialVersion(actor.accountId);
    const session = this.sessions.issueSession(actor.accountId, now);
    return { status: 'ok', session };
  }

  requestPasswordReset(email: string, now: number = Date.now()): { status: 'ok' } {
    const bucket = this.resetRequestLog.get(email) ?? [];
    const withinWindow = bucket.filter((ts) => ts > now - RESET_RATE_LIMIT_WINDOW_MS);
    withinWindow.push(now);
    this.resetRequestLog.set(email, withinWindow);
    if (withinWindow.length > RESET_RATE_LIMIT_MAX_REQUESTS) {
      return { status: 'ok' };
    }
    const account = [...this.profiles.values()].find((candidate) => candidate.verifiedEmail === email);
    if (account) {
      const token = randomBytes(24).toString('hex');
      this.resetTokens.set(token, { token, accountId: account.accountId, expiresAt: now + RESET_TOKEN_TTL_MS, consumed: false });
      this.deliveredLinks.push({ accountId: account.accountId, email, token });
    }
    return { status: 'ok' };
  }

  completePasswordReset(token: string, newPassword: string, now: number = Date.now()): CompleteResetResult {
    const record = this.resetTokens.get(token);
    if (!record || record.consumed || record.expiresAt <= now) {
      return { status: 'invalid-token' };
    }
    record.consumed = true;
    this.passwordHashes.set(record.accountId, hashPassword(newPassword));
    this.sessions.incrementCredentialVersion(record.accountId);
    return { status: 'ok', accountId: record.accountId };
  }

  enrollTotp(actor: SelfScopeActorContext): { secret: string; otpauthUri: string } {
    if (!authorizeSelf(actor, 'mfa.self.enroll')) {
      throw new AccountAuthorizationDeniedError('mfa.self.enroll');
    }
    const secret = randomBytes(20);
    this.totpFactors.set(actor.accountId, {
      encryptedSecret: encryptSecret(secret.toString('hex'), this.encryptionKey),
      active: false,
      acceptedSteps: new Set(),
      consecutiveFailures: 0,
      lockedUntil: 0,
    });
    return {
      secret: secret.toString('hex'),
      otpauthUri: `otpauth://totp/AIRA2:${actor.accountId}?secret=${secret.toString('hex')}`,
    };
  }

  /** MfaCheck.isRequired extension consumed by DES-AIRA2-001 at login (REQ-MULTIUSER-035). */
  isMfaRequired(accountId: string): boolean {
    return this.totpFactors.get(accountId)?.active === true;
  }

  confirmTotpEnrollment(accountId: string, code: string, now: number = Date.now()): boolean {
    const factor = this.totpFactors.get(accountId);
    if (!factor) return false;
    const result = this.verifyCodeAgainstFactor(factor, code, now);
    if (result === 'valid') {
      factor.active = true;
      return true;
    }
    return false;
  }

  /** MfaCheck extension consumed by DES-AIRA2-001 at login. */
  verify(accountId: string, code: string, now: number = Date.now()): MfaVerifyResult {
    const factor = this.totpFactors.get(accountId);
    if (!factor || !factor.active) {
      return 'invalid';
    }
    return this.verifyCodeAgainstFactor(factor, code, now);
  }

  private verifyCodeAgainstFactor(factor: TotpFactor, code: string, now: number): MfaVerifyResult {
    if (factor.lockedUntil > now) {
      return 'locked';
    }
    const secretHex = decryptSecret(factor.encryptedSecret, this.encryptionKey);
    const step = Math.floor(now / TOTP_STEP_MS);
    const expected = generateTotpCode(Buffer.from(secretHex, 'hex'), step);
    if (code !== expected || factor.acceptedSteps.has(step)) {
      factor.consecutiveFailures += 1;
      if (factor.consecutiveFailures >= MFA_FAILURE_LOCKOUT_THRESHOLD) {
        factor.lockedUntil = now + MFA_LOCKOUT_COOLDOWN_MS;
      }
      return 'invalid';
    }
    factor.acceptedSteps.add(step);
    factor.consecutiveFailures = 0;
    return 'valid';
  }

  private requireProfile(accountId: string): ProfileRecord {
    const profile = this.profiles.get(accountId);
    if (!profile) {
      throw new Error(`unknown account: ${accountId}`);
    }
    return profile;
  }
}

/** RFC 6238/4226 TOTP code generation using HMAC-SHA1. */
export function generateTotpCode(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const code = (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
  return code;
}

import { randomBytes } from 'node:crypto';
import type { Account } from './account.js';

export interface Session {
  id: string;
  accountId: string;
  issuedAt: number;
  expiresAt: number;
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSession(
  account: Account,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): Session {
  return {
    id: randomBytes(32).toString('hex'),
    accountId: account.id,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
}

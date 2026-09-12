import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AuthProvider } from './login.js';
import { InvalidCredentialsError } from './login.js';

export interface PasswordCredentialLookup {
  getPasswordCredential(externalIdentity: string): string | null;
}

const PASSWORD_HASH_PREFIX = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** @id CODE-AIRA2-AUTH-005
 * @implements REQ-MULTIUSER-001 REQ-MULTIUSER-002
 * @design DES-AIRA2-001
 * Uses Node's built-in scrypt instead of adding a new bcrypt runtime
 * dependency for this release; key rotation/migration of existing hashes is
 * intentionally out of scope and must be handled by a future change.
 */
export class PasswordAuthProvider implements AuthProvider {
  readonly method = 'password' as const;

  constructor(private readonly credentials: PasswordCredentialLookup) {}

  resolveExternalIdentity(credentials: unknown): string {
    const submitted = credentials as { username?: string; externalIdentity?: string; password?: string };
    const externalIdentity = submitted.username ?? submitted.externalIdentity;
    if (!externalIdentity || !submitted.password) {
      throw new InvalidCredentialsError();
    }
    const storedHash = this.credentials.getPasswordCredential(externalIdentity);
    if (!storedHash || !verifyPasswordHash(submitted.password, storedHash)) {
      throw new InvalidCredentialsError();
    }
    return externalIdentity;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_BYTES);
  return [PASSWORD_HASH_PREFIX, salt.toString('hex'), derived.toString('hex')].join('$');
}

export function verifyPasswordHash(password: string, storedHash: string): boolean {
  const [prefix, saltHex, derivedHex] = storedHash.split('$');
  if (prefix !== PASSWORD_HASH_PREFIX || !saltHex || !derivedHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(derivedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

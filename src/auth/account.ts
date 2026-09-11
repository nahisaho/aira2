/** @id CODE-AIRA2-AUTH-001
 * @implements REQ-MULTIUSER-002
 * @design DES-AIRA2-001
 */
export type Role = 'admin' | 'member';

export interface CreateAccountInput {
  displayName: string;
  externalIdentity: string;
  role?: Role;
  isServiceAccount?: boolean;
  isShared?: boolean;
  assignedPersonId?: string;
}

export interface Account {
  id: string;
  displayName: string;
  externalIdentity: string;
  role: Role;
  isServiceAccount: boolean;
  isShared: boolean;
  assignedPersonId: string | null;
}

export function createAccount(input: CreateAccountInput): Account {
  return {
    id: input.externalIdentity,
    displayName: input.displayName,
    externalIdentity: input.externalIdentity,
    role: input.role ?? 'member',
    isServiceAccount: input.isServiceAccount ?? false,
    isShared: input.isShared ?? false,
    assignedPersonId: input.assignedPersonId ?? null,
  };
}

export function isAdmin(account: Account): boolean {
  return account.role === 'admin';
}

/** @id CODE-AIRA2-AUTH-002
 * @implements REQ-MULTIUSER-010
 * @design DES-AIRA2-001
 */
export function canSign(account: Account): boolean {
  return !account.isServiceAccount && !account.isShared && account.assignedPersonId !== null;
}

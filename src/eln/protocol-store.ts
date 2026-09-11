export type ProtocolVersionStatus = 'draft' | 'approved';

export interface ProtocolVersion {
  protocolVersionId: string;
  protocolId: string;
  projectId: string;
  versionNumber: number;
  content: string;
  status: ProtocolVersionStatus;
}

/** Identity token representing the trusted protocol-approval subsystem
 * (DES-AIRA2-007). Only the holder of this exact token may transition a
 * protocol version's status to `approved`; no other caller can. */
export const TRUSTED_APPROVAL_SUBSYSTEM: unique symbol = Symbol('trusted-approval-subsystem');

let protocolCounter = 0;
let protocolVersionCounter = 0;

/** @id CODE-AIRA2-ELN-001
 * @implements REQ-ELN-003
 * @design DES-AIRA2-005
 * Reusable protocol/SOP documents, versioned independently of any
 * experiment record. A version's status only ever changes via
 * `markApproved`, gated by the trusted approval-subsystem token.
 */
export class ProtocolStore {
  private readonly protocols = new Map<string, ProtocolVersion[]>();

  createProtocol(projectId: string, content: string): ProtocolVersion {
    const protocolId = `protocol-${++protocolCounter}`;
    const version: ProtocolVersion = {
      protocolVersionId: `protocol-version-${++protocolVersionCounter}`,
      protocolId,
      projectId,
      versionNumber: 1,
      content,
      status: 'draft',
    };
    this.protocols.set(protocolId, [version]);
    return version;
  }

  createProtocolVersion(protocolId: string, content: string): ProtocolVersion {
    const versions = this.protocols.get(protocolId);
    if (!versions) {
      throw new Error(`Unknown protocol: ${protocolId}`);
    }
    const version: ProtocolVersion = {
      protocolVersionId: `protocol-version-${++protocolVersionCounter}`,
      protocolId,
      projectId: versions[0]!.projectId,
      versionNumber: versions.length + 1,
      content,
      status: 'draft',
    };
    versions.push(version);
    return version;
  }

  getVersion(protocolVersionId: string): ProtocolVersion | undefined {
    for (const versions of this.protocols.values()) {
      const found = versions.find((v) => v.protocolVersionId === protocolVersionId);
      if (found) return found;
    }
    return undefined;
  }

  /** Callable only by DES-AIRA2-007 via the trusted approval-subsystem token. */
  markApproved(token: typeof TRUSTED_APPROVAL_SUBSYSTEM, protocolVersionId: string): void {
    if (token !== TRUSTED_APPROVAL_SUBSYSTEM) {
      throw new Error('markApproved may only be invoked by the trusted approval subsystem');
    }
    const version = this.getVersion(protocolVersionId);
    if (!version) {
      throw new Error(`Unknown protocol version: ${protocolVersionId}`);
    }
    version.status = 'approved';
  }
}

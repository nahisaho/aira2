import { describe, expect, it } from 'vitest';
import { ProtocolStore, TRUSTED_APPROVAL_SUBSYSTEM } from './protocol-store.js';

/** @id TEST-AIRA2-ELN-003
 * @verifies REQ-ELN-003
 */
describe('protocol/SOP creation and versioning', () => {
  it('TEST-AIRA2-ELN-003 creates and versions a protocol independent of any experiment record, gating approval to the trusted subsystem', () => {
    const store = new ProtocolStore();
    const v1 = store.createProtocol('project-1', 'Protocol v1 content');
    expect(v1.versionNumber).toBe(1);
    expect(v1.status).toBe('draft');

    const v2 = store.createProtocolVersion(v1.protocolId, 'Protocol v2 content');
    expect(v2.versionNumber).toBe(2);
    expect(v2.protocolId).toBe(v1.protocolId);
    expect(v2.status).toBe('draft');

    expect(() =>
      store.markApproved('not-the-subsystem' as unknown as typeof TRUSTED_APPROVAL_SUBSYSTEM, v2.protocolVersionId),
    ).toThrow();

    store.markApproved(TRUSTED_APPROVAL_SUBSYSTEM, v2.protocolVersionId);
    expect(store.getVersion(v2.protocolVersionId)?.status).toBe('approved');
    expect(store.getVersion(v1.protocolVersionId)?.status).toBe('draft');
  });
});

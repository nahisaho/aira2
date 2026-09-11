import { describe, expect, it } from 'vitest';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';
import { GraphDbSupervisor } from '../graphrag/graphdb.js';
import { GraphRagService, type GraphRagLlmGateway } from '../graphrag/graphrag-service.js';
import { GraphRagUiController } from './graphrag-ui.js';
import { DesignSystemRegistry } from './design-system.js';

function setup() {
  const authz = new ProjectAuthorizationService(new AuditLog(), {
    terminateSessionsAndConnections: () => undefined,
  });
  authz.createProject('owner-1', 'project-1');
  const supervisor = new GraphDbSupervisor();
  const gateway: GraphRagLlmGateway = {
    resolveBackend: () => 'openai',
    chat: async (_actor, _projectId, request) => ({
      providerId: 'openai',
      content: `answer for: ${request.messages.at(-1)?.content}`,
    }),
  };
  const service = new GraphRagService(authz, supervisor, gateway);
  const registry = new DesignSystemRegistry();
  const controller = new GraphRagUiController(service, registry);
  return { controller };
}

const actor = { accountId: 'owner-1' };

/** @id TEST-AIRA2-GUI-004
 * @verifies REQ-GUI-004
 */
describe('Graph RAG UI', () => {
  it('TEST-AIRA2-GUI-004 indexes a sample document and returns a queried answer with at least one traceable source citation', async () => {
    const { controller } = setup();

    await controller.indexDocuments(actor, 'project-1', [
      { documentId: 'doc-1', content: 'Sample Protocol content about Reagent stability.' },
    ]);

    const result = await controller.query(actor, 'project-1', 'Reagent stability');

    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]!.sourceDocumentId).toBe('doc-1');
    expect(result.answer.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import { ProjectAuthorizationService } from '../authz/project-authz.js';
import { AuditLog } from '../authz/audit.js';
import { GraphDbSupervisor } from './graphdb.js';
import { GraphRagService, NoCitableAnswerError, type GraphRagLlmGateway } from './graphrag-service.js';
import type { BackendSelection } from '../llm/gateway.js';
import type { ProviderId } from '../llm/adapters.js';

function fakeLlmGateway(defaultProvider: ProviderId = 'openai') {
  const perProjectProvider = new Map<string, ProviderId>();
  const chatCalls: { projectId: string; providerId: ProviderId }[] = [];
  const gateway: GraphRagLlmGateway = {
    resolveBackend: (_actor, projectId) =>
      ({ providerId: perProjectProvider.get(projectId) ?? defaultProvider, model: 'default' }) satisfies BackendSelection,
    chat: async (_actor, projectId, request) => {
      const resolved = gateway.resolveBackend(_actor, projectId);
      const providerId = typeof resolved === 'string' ? resolved : resolved.providerId;
      chatCalls.push({ projectId, providerId });
      return { providerId, content: `answer from ${providerId} for: ${request.messages.at(-1)?.content}` };
    },
  };
  return { gateway, perProjectProvider, chatCalls };
}

function setup(defaultProvider: ProviderId = 'openai') {
  const authz = new ProjectAuthorizationService(new AuditLog(), {
    terminateSessionsAndConnections: () => undefined,
  });
  authz.createProject('owner-1', 'project-a');
  authz.createProject('owner-1', 'project-b');
  const supervisor = new GraphDbSupervisor();
  const { gateway, perProjectProvider, chatCalls } = fakeLlmGateway(defaultProvider);
  const service = new GraphRagService(authz, supervisor, gateway);
  return { authz, supervisor, service, perProjectProvider, chatCalls };
}

const actor = { accountId: 'owner-1' };

/** @id TEST-AIRA2-GRAPHRAG-001
 * @verifies REQ-GRAPHRAG-001
 */
describe('built-in Graph RAG MCP server', () => {
  it('TEST-AIRA2-GRAPHRAG-001 exposes index/query/stats MCP tools only once enabled for a project', () => {
    const { service } = setup();
    expect(service.listTools(actor, 'project-a')).toEqual([]);
    service.enableForProject('project-a');
    expect(service.listTools(actor, 'project-a')).toEqual(['index_documents', 'query', 'stats']);
    expect(service.listTools(actor, 'project-b')).toEqual([]);
  });
});

/** @id TEST-AIRA2-GRAPHRAG-002
 * @verifies REQ-GRAPHRAG-002
 */
describe('document indexing', () => {
  it('TEST-AIRA2-GRAPHRAG-002 indexes a document and reports a non-zero node/entity count', async () => {
    const { service } = setup();
    service.enableForProject('project-a');
    await service.indexDocuments(actor, 'project-a', [
      { documentId: 'doc-1', content: 'The Kinase enzyme reaction was measured under Assay conditions.' },
    ]);
    const stats = service.stats(actor, 'project-a');
    expect(stats.nodeCount).toBeGreaterThan(0);
    expect(stats.entityCount).toBeGreaterThan(0);
  });
});

/** @id TEST-AIRA2-GRAPHRAG-003
 * @verifies REQ-GRAPHRAG-003
 */
describe('hybrid query retrieval', () => {
  it('TEST-AIRA2-GRAPHRAG-003 merges vector and BM25 candidates via Reciprocal Rank Fusion', async () => {
    const { service } = setup();
    service.enableForProject('project-a');
    await service.indexDocuments(actor, 'project-a', [
      { documentId: 'doc-1', content: 'Kinase enzyme kinetics assay results were consistent.' },
      { documentId: 'doc-2', content: 'Unrelated Spectrophotometer calibration notes.' },
    ]);

    const result = await service.query(actor, ['project-a'], 'Kinase enzyme kinetics assay');

    expect(result.debug.vectorCandidates.length).toBeGreaterThan(0);
    expect(result.debug.bm25Candidates.length).toBeGreaterThan(0);
    expect(result.debug.fused.length).toBeGreaterThan(0);
    expect(result.debug.fused[0]?.documentId).toBe('doc-1');
  });
});

/** @id TEST-AIRA2-GRAPHRAG-004
 * @verifies REQ-GRAPHRAG-004
 */
describe('LLM backend consistency for Graph RAG generation', () => {
  it('TEST-AIRA2-GRAPHRAG-004 generates the answer using the requesting project\'s configured backend, not a hard-coded provider', async () => {
    const { service, perProjectProvider, chatCalls } = setup('openai');
    perProjectProvider.set('project-a', 'anthropic');
    service.enableForProject('project-a');
    await service.indexDocuments(actor, 'project-a', [{ documentId: 'doc-1', content: 'Some Result content here.' }]);

    const result = await service.query(actor, ['project-a'], 'Result content');

    expect(result.debug.generationProviderId).toBe('anthropic');
    expect(chatCalls.some((c) => c.providerId === 'anthropic')).toBe(true);
    expect(chatCalls.every((c) => c.providerId !== 'openai')).toBe(true);
  });
});

/** @id TEST-AIRA2-GRAPHRAG-005
 * @verifies REQ-GRAPHRAG-005
 */
describe('federated query across projects', () => {
  it('TEST-AIRA2-GRAPHRAG-005 merges ranked results from every accessible project via RRF and silently drops inaccessible ones', async () => {
    const { authz, service } = setup();
    authz.createProject('owner-1', 'project-c');
    service.enableForProject('project-a');
    service.enableForProject('project-c');
    await service.indexDocuments(actor, 'project-a', [
      { documentId: 'doc-a1', content: 'Federated Reagent study alpha.' },
    ]);
    await service.indexDocuments(actor, 'project-c', [
      { documentId: 'doc-c1', content: 'Federated Reagent study gamma.' },
    ]);

    const strangerActor = { accountId: 'stranger' };
    const result = await service.query(strangerActor.accountId === 'stranger' ? actor : actor, [
      'project-a',
      'project-c',
    ], 'Federated Reagent study');

    const documentIds = result.debug.fused.map((f) => f.documentId);
    expect(documentIds).toEqual(expect.arrayContaining(['doc-a1', 'doc-c1']));

    // A project the user cannot access must be silently dropped, not error.
    const noAccessResult = await service.query(strangerActor, ['project-a', 'project-c'], 'Federated Reagent study');
    expect(noAccessResult.citations.length).toBe(0);
  });
});

/** @id TEST-AIRA2-GRAPHRAG-013
 * @verifies REQ-GRAPHRAG-013
 */
describe('query citation', () => {
  it('TEST-AIRA2-GRAPHRAG-013 returns a resolvable citation for every answer across ten distinct queries, never returning an uncited answer', async () => {
    const { service } = setup();
    service.enableForProject('project-a');
    await service.indexDocuments(actor, 'project-a', [
      { documentId: 'doc-1', content: 'Alpha Beta Gamma Delta Epsilon reaction data.' },
      { documentId: 'doc-2', content: 'Zeta Eta Theta Iota Kappa control data.' },
    ]);

    const questions = [
      'Alpha reaction',
      'Beta reaction',
      'Gamma reaction',
      'Delta reaction',
      'Epsilon reaction',
      'Zeta control',
      'Eta control',
      'Theta control',
      'Iota control',
      'Kappa control',
    ];

    for (const question of questions) {
      const result = await service.query(actor, ['project-a'], question);
      expect(result.citations.length).toBeGreaterThan(0);
      for (const citation of result.citations) {
        expect(['doc-1', 'doc-2']).toContain(citation.sourceDocumentId);
      }
    }

    await expect(service.query(actor, ['project-a'], 'completely unrelated nonsense xyzzy')).rejects.toThrow(
      NoCitableAnswerError,
    );
  });
});

/** @id TEST-AIRA2-GRAPHRAG-014
 * @verifies REQ-GRAPHRAG-014
 */
describe('embedding capability matrix and fallback', () => {
  it('TEST-AIRA2-GRAPHRAG-014 indexes using the documented fallback embedding provider for a backend without native embedding support', async () => {
    const { service, perProjectProvider, supervisor } = setup();
    perProjectProvider.set('project-a', 'anthropic');
    service.enableForProject('project-a');

    await service.indexDocuments(actor, 'project-a', [{ documentId: 'doc-1', content: 'Fallback Embedding test.' }]);

    const capabilities = service.getEmbeddingCapabilities();
    expect(capabilities.anthropic.nativeEmbedding).toBe(false);
    expect(capabilities.anthropic.fallbackProvider).toBe('openai');

    const db = supervisor.ensureRunning('project-a');
    expect(db.getEmbeddingModel('doc-1')).toBe(capabilities.anthropic.fallbackModel);
  });
});

/** @id TEST-AIRA2-GRAPHRAG-015
 * @verifies REQ-GRAPHRAG-015
 */
describe('re-index on embedding model change', () => {
  it('TEST-AIRA2-GRAPHRAG-015 marks existing vectors stale and excludes them from queries until the project is re-indexed', async () => {
    const { service, perProjectProvider, supervisor } = setup('openai');
    service.enableForProject('project-a');
    await service.indexDocuments(actor, 'project-a', [
      { documentId: 'doc-1', content: 'Stability Marker measurement content.' },
    ]);

    let result = await service.query(actor, ['project-a'], 'Stability Marker measurement');
    expect(result.citations.map((c) => c.sourceDocumentId)).toContain('doc-1');

    perProjectProvider.set('project-a', 'anthropic');
    const db = supervisor.ensureRunning('project-a');
    expect(db.isStale('doc-1')).toBe(false);

    // Triggers the staleness check against the newly effective embedding model.
    service.stats(actor, 'project-a');
    expect(db.isStale('doc-1')).toBe(true);

    await expect(service.query(actor, ['project-a'], 'Stability Marker measurement')).rejects.toThrow(
      NoCitableAnswerError,
    );

    await service.reindex(actor, 'project-a');
    expect(db.isStale('doc-1')).toBe(false);
    result = await service.query(actor, ['project-a'], 'Stability Marker measurement');
    expect(result.citations.map((c) => c.sourceDocumentId)).toContain('doc-1');
  });
});

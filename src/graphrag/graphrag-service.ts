import type { ProjectAuthorizationService, ActorContext } from '../authz/project-authz.js';
import { AuthorizationDeniedError } from '../authz/project-authz.js';
import type { ProviderId, ChatRequest } from '../llm/adapters.js';
import { EMBEDDING_CAPABILITY_MATRIX, effectiveEmbeddingModel } from './embedding-capability.js';
import { GraphDbSupervisor, reciprocalRankFusion, type RetrievalCandidate } from './graphdb.js';
import type { SourceDocument, GraphDbStats } from './graphdb.js';

export interface GraphRagLlmGateway {
  resolveBackend(actor: ActorContext, projectId: string): ProviderId;
  chat(actor: ActorContext, projectId: string, request: ChatRequest): Promise<{ providerId: ProviderId; content: string }>;
}

export interface Citation {
  sourceDocumentId: string;
  sourceDocumentVersion: number;
  locator: string;
}

export interface QueryResult {
  answer: string;
  citations: Citation[];
  debug: {
    vectorCandidates: RetrievalCandidate[];
    bm25Candidates: RetrievalCandidate[];
    fused: { documentId: string; documentVersion: number; rrfScore: number }[];
    generationProviderId: ProviderId;
  };
}

export class NoCitableAnswerError extends Error {}

/** @id CODE-AIRA2-GRAPHRAG-004
 * @implements REQ-GRAPHRAG-001 REQ-GRAPHRAG-004 REQ-GRAPHRAG-005
 * @design DES-AIRA2-009
 * Per-project built-in MCP server: exposes its tool list only once a
 * project has enabled Graph RAG (via DES-AIRA2-008), generates answers
 * using the requesting user/project's configured LLM backend (never a
 * hard-coded provider), and silently drops any project the requesting
 * user cannot access from a federated query rather than erroring.
 */
export class GraphRagService {
  private readonly enabledProjects = new Set<string>();

  constructor(
    private readonly authz: ProjectAuthorizationService,
    private readonly supervisor: GraphDbSupervisor,
    private readonly llmGateway: GraphRagLlmGateway,
  ) {}

  private requireAuthorized(actor: ActorContext, projectId: string, action: string): void {
    if (!this.authz.authorize(actor, projectId, action)) {
      throw new AuthorizationDeniedError(action);
    }
  }

  enableForProject(projectId: string): void {
    this.enabledProjects.add(projectId);
  }

  isEnabledForProject(projectId: string): boolean {
    return this.enabledProjects.has(projectId);
  }

  listTools(actor: ActorContext, projectId: string): string[] {
    if (!this.isEnabledForProject(projectId)) return [];
    this.requireAuthorized(actor, projectId, 'graphrag.view');
    return ['index_documents', 'query', 'stats'];
  }

  private currentEffectiveModel(actor: ActorContext, projectId: string): string {
    const providerId = this.llmGateway.resolveBackend(actor, projectId);
    return effectiveEmbeddingModel(providerId).model;
  }

  /** @id CODE-AIRA2-GRAPHRAG-005
   * @implements REQ-GRAPHRAG-002 REQ-GRAPHRAG-014
   * @design DES-AIRA2-009
   */
  async indexDocuments(actor: ActorContext, projectId: string, docs: SourceDocument[]): Promise<void> {
    this.requireAuthorized(actor, projectId, 'graphrag.create');
    const db = this.supervisor.ensureRunning(projectId);
    const model = this.currentEffectiveModel(actor, projectId);
    db.markStaleIfModelChanged(model);
    for (const doc of docs) {
      db.indexDocument(doc, model);
    }
  }

  stats(actor: ActorContext, projectId: string): GraphDbStats {
    this.requireAuthorized(actor, projectId, 'graphrag.view');
    const db = this.supervisor.ensureRunning(projectId);
    db.markStaleIfModelChanged(this.currentEffectiveModel(actor, projectId));
    return db.stats();
  }

  getEmbeddingCapabilities() {
    return EMBEDDING_CAPABILITY_MATRIX;
  }

  /** @id CODE-AIRA2-GRAPHRAG-006
   * @implements REQ-GRAPHRAG-003 REQ-GRAPHRAG-013 REQ-GRAPHRAG-015
   * @design DES-AIRA2-009
   * Every answer must include at least one citation resolvable to an
   * indexed source document version, or no answer is returned at all.
   */
  async query(actor: ActorContext, projectIds: string[], question: string): Promise<QueryResult> {
    const vectorCandidates: RetrievalCandidate[] = [];
    const bm25Candidates: RetrievalCandidate[] = [];
    const rankedLists: RetrievalCandidate[][] = [];
    const accessibleProjectIds: string[] = [];

    for (const projectId of projectIds) {
      try {
        this.requireAuthorized(actor, projectId, 'graphrag.view');
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          continue; // Silently drop projects the requester cannot access.
        }
        throw error;
      }
      accessibleProjectIds.push(projectId);
      const db = this.supervisor.ensureRunning(projectId);
      db.markStaleIfModelChanged(this.currentEffectiveModel(actor, projectId));
      const vectorHits = db.searchVector(question);
      const bm25Hits = db.searchBm25(question);
      vectorCandidates.push(...vectorHits);
      bm25Candidates.push(...bm25Hits);
      rankedLists.push(vectorHits, bm25Hits);
    }

    const fused = reciprocalRankFusion(rankedLists);

    // No accessible project at all: return gracefully with no citations
    // rather than raising NoCitableAnswerError (which signals that an
    // accessible, indexed project genuinely had nothing relevant to cite).
    if (accessibleProjectIds.length === 0) {
      return {
        answer: '',
        citations: [],
        debug: { vectorCandidates, bm25Candidates, fused, generationProviderId: undefined as unknown as ProviderId },
      };
    }

    if (fused.length === 0) {
      throw new NoCitableAnswerError('No indexed source document could be cited for this query');
    }

    const topFused = fused.slice(0, 3);
    const citations: Citation[] = topFused.map((entry) => ({
      sourceDocumentId: entry.documentId,
      sourceDocumentVersion: entry.documentVersion,
      locator: `doc:${entry.documentId}#v${entry.documentVersion}`,
    }));

    const requestingProjectId = accessibleProjectIds[0]!;
    const generationProviderId = this.llmGateway.resolveBackend(actor, requestingProjectId);
    const chatRequest: ChatRequest = { messages: [{ role: 'user', content: question }] };
    const chatResponse = await this.llmGateway.chat(actor, requestingProjectId, chatRequest);

    return {
      answer: chatResponse.content,
      citations,
      debug: { vectorCandidates, bm25Candidates, fused, generationProviderId },
    };
  }

  async reindex(actor: ActorContext, projectId: string): Promise<void> {
    this.requireAuthorized(actor, projectId, 'graphrag.modify');
    const db = this.supervisor.ensureRunning(projectId);
    db.reindexAll(this.currentEffectiveModel(actor, projectId));
  }
}

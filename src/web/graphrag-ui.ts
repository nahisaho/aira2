import type { ActorContext } from '../authz/project-authz.js';
import { GraphRagService, type Citation } from '../graphrag/graphrag-service.js';
import type { SourceDocument } from '../graphrag/graphdb.js';
import { DesignSystemRegistry } from './design-system.js';

export interface GraphRagQueryView {
  answer: string;
  citations: Citation[];
}

/** @id CODE-AIRA2-GUI-005
 * @implements REQ-GUI-004
 * @design DES-AIRA2-010
 * View-model for the Graph RAG UI area: lets a user index documents into,
 * and query, a project's Graph RAG knowledge base, always rendering
 * answers together with their source citations.
 */
export class GraphRagUiController {
  constructor(
    private readonly graphRagService: GraphRagService,
    registry: DesignSystemRegistry = new DesignSystemRegistry(),
  ) {
    registry.register('graphrag');
  }

  async indexDocuments(actor: ActorContext, projectId: string, docs: SourceDocument[]): Promise<void> {
    await this.graphRagService.indexDocuments(actor, projectId, docs);
  }

  async query(actor: ActorContext, projectId: string, question: string): Promise<GraphRagQueryView> {
    const result = await this.graphRagService.query(actor, [projectId], question);
    return { answer: result.answer, citations: result.citations };
  }
}

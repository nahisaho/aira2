import { createHash } from 'node:crypto';
import type { EffectiveEmbeddingModel } from './embedding-capability.js';

export interface SourceDocument {
  documentId: string;
  content: string;
}

interface IndexedDocument {
  documentId: string;
  documentVersion: number;
  content: string;
  embeddingModel: string;
  vector: number[];
  stale: boolean;
}

export interface RetrievalCandidate {
  documentId: string;
  documentVersion: number;
  score: number;
}

export interface GraphDbStats {
  nodeCount: number;
  entityCount: number;
  edgeCount: number;
}

const VECTOR_DIMENSIONS = 64;

/**
 * Stands in for a real semantic embedding: hashes each token into one of
 * VECTOR_DIMENSIONS buckets and counts occurrences, so texts sharing
 * vocabulary produce vectors with non-zero cosine similarity while texts
 * with disjoint vocabulary produce (near-)zero similarity, mirroring how a
 * real embedding would separate related from unrelated content.
 */
function embed(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    const digest = createHash('sha256').update(token).digest();
    const bucket = (digest[0] ?? 0) % VECTOR_DIMENSIONS;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  return vector;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function extractEntities(content: string): string[] {
  const matches = content.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
  return Array.from(new Set(matches));
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** @id CODE-AIRA2-GRAPHRAG-002
 * @implements REQ-GRAPHRAG-002 REQ-GRAPHRAG-003 REQ-GRAPHRAG-013 REQ-GRAPHRAG-015
 * @design DES-AIRA2-009
 * Project-isolated in-process store standing in for a supervised
 * aira-graphdb process: indexes documents into a naive knowledge graph
 * (extracted entity nodes) plus a vector index and a BM25 term index, and
 * answers hybrid retrieval queries. Vectors indexed under a since-changed
 * embedding model are marked stale and excluded from query results.
 */
export class ProjectGraphDb {
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly entities = new Set<string>();

  indexDocument(doc: SourceDocument, embeddingModel: string): void {
    const existing = this.documents.get(doc.documentId);
    const documentVersion = (existing?.documentVersion ?? 0) + 1;
    this.documents.set(doc.documentId, {
      documentId: doc.documentId,
      documentVersion,
      content: doc.content,
      embeddingModel,
      vector: embed(doc.content),
      stale: false,
    });
    for (const entity of extractEntities(doc.content)) {
      this.entities.add(entity);
    }
  }

  markStaleIfModelChanged(currentModel: string): void {
    for (const doc of this.documents.values()) {
      if (doc.embeddingModel !== currentModel) {
        doc.stale = true;
      }
    }
  }

  reindexAll(currentModel: string): void {
    for (const doc of this.documents.values()) {
      doc.vector = embed(doc.content);
      doc.embeddingModel = currentModel;
      doc.stale = false;
    }
  }

  stats(): GraphDbStats {
    return {
      nodeCount: this.documents.size + this.entities.size,
      entityCount: this.entities.size,
      edgeCount: this.entities.size > 0 ? this.documents.size * this.entities.size : 0,
    };
  }

  getContent(documentId: string): string | undefined {
    return this.documents.get(documentId)?.content;
  }

  getEmbeddingModel(documentId: string): string | undefined {
    return this.documents.get(documentId)?.embeddingModel;
  }

  isStale(documentId: string): boolean | undefined {
    return this.documents.get(documentId)?.stale;
  }

  searchVector(query: string, limit = 5): RetrievalCandidate[] {
    const queryVector = embed(query);
    return Array.from(this.documents.values())
      .filter((doc) => !doc.stale)
      .map((doc) => ({
        documentId: doc.documentId,
        documentVersion: doc.documentVersion,
        score: cosineSimilarity(queryVector, doc.vector),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  searchBm25(query: string, limit = 5): RetrievalCandidate[] {
    const queryTerms = tokenize(query);
    return Array.from(this.documents.values())
      .filter((doc) => !doc.stale)
      .map((doc) => {
        const docTerms = tokenize(doc.content);
        const overlap = queryTerms.filter((term) => docTerms.includes(term)).length;
        return { documentId: doc.documentId, documentVersion: doc.documentVersion, score: overlap };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** @id CODE-AIRA2-GRAPHRAG-003
 * @implements REQ-GRAPHRAG-006
 * @design DES-AIRA2-009
 * Supervises one ProjectGraphDb instance per project. The underlying data
 * (documents/entities/vectors) always lives on the ProjectGraphDb instance
 * itself, so a simulated crash-and-restart preserves indexed state while
 * incrementing a restart counter, and never touches another project's db.
 */
export class GraphDbSupervisor {
  private readonly dbs = new Map<string, ProjectGraphDb>();
  private readonly alive = new Map<string, boolean>();
  private readonly restartCounts = new Map<string, number>();

  ensureRunning(projectId: string): ProjectGraphDb {
    if (!this.dbs.has(projectId)) {
      this.dbs.set(projectId, new ProjectGraphDb());
      this.alive.set(projectId, true);
      this.restartCounts.set(projectId, 0);
    }
    if (!this.alive.get(projectId)) {
      this.restartCounts.set(projectId, (this.restartCounts.get(projectId) ?? 0) + 1);
      this.alive.set(projectId, true);
    }
    return this.dbs.get(projectId)!;
  }

  /** Test-only: simulates an unexpected process exit for a project's db. */
  simulateCrash(projectId: string): void {
    this.alive.set(projectId, false);
  }

  isAlive(projectId: string): boolean {
    return this.alive.get(projectId) ?? false;
  }

  restartCount(projectId: string): number {
    return this.restartCounts.get(projectId) ?? 0;
  }
}

export function reciprocalRankFusion(
  rankedLists: RetrievalCandidate[][],
  k = 60,
): { documentId: string; documentVersion: number; rrfScore: number }[] {
  const scores = new Map<string, { documentVersion: number; rrfScore: number }>();
  for (const list of rankedLists) {
    list.forEach((candidate, index) => {
      const existing = scores.get(candidate.documentId);
      const increment = 1 / (k + index + 1);
      if (existing) {
        existing.rrfScore += increment;
      } else {
        scores.set(candidate.documentId, { documentVersion: candidate.documentVersion, rrfScore: increment });
      }
    });
  }
  return Array.from(scores.entries())
    .map(([documentId, value]) => ({ documentId, documentVersion: value.documentVersion, rrfScore: value.rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

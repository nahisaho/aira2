import type { ProviderId } from '../llm/adapters.js';

export interface EmbeddingCapability {
  nativeEmbedding: boolean;
  fallbackProvider: ProviderId;
  fallbackModel: string;
}

export interface EffectiveEmbeddingModel {
  provider: ProviderId;
  model: string;
}

/** @id CODE-AIRA2-GRAPHRAG-001
 * @implements REQ-GRAPHRAG-014
 * @design DES-AIRA2-009
 * Documents which configured LLM backend providers support native
 * embedding generation, and which fallback provider/model Graph RAG
 * indexing must use for a provider that does not.
 */
export const EMBEDDING_CAPABILITY_MATRIX: Record<ProviderId, EmbeddingCapability> = {
  'github-copilot-cli': {
    nativeEmbedding: false,
    fallbackProvider: 'openai',
    fallbackModel: 'text-embedding-3-small',
  },
  openai: {
    nativeEmbedding: true,
    fallbackProvider: 'openai',
    fallbackModel: 'text-embedding-3-small',
  },
  'azure-openai': {
    nativeEmbedding: true,
    fallbackProvider: 'azure-openai',
    fallbackModel: 'text-embedding-3-small',
  },
  anthropic: {
    nativeEmbedding: false,
    fallbackProvider: 'openai',
    fallbackModel: 'text-embedding-3-small',
  },
};

export function effectiveEmbeddingModel(providerId: ProviderId): EffectiveEmbeddingModel {
  const capability = EMBEDDING_CAPABILITY_MATRIX[providerId];
  if (capability.nativeEmbedding) {
    return { provider: providerId, model: `${providerId}-native-embedding` };
  }
  return { provider: capability.fallbackProvider, model: capability.fallbackModel };
}

/**
 * Embedding Abstraction Layer
 * OpenAI-compatible API for various embedding providers.
 *
 * Note: Some providers (e.g. Jina) support extra parameters like `task` and
 * `normalized` on the embeddings endpoint. The OpenAI SDK types do not include
 * these fields, so we pass them via a narrow `any` cast.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";

// ============================================================================
// Embedding Cache (LRU with TTL)
// ============================================================================

interface CacheEntry {
  vector: number[];
  createdAt: number;
}

class EmbeddingCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  public hits = 0;
  public misses = 0;

  constructor(maxSize = 256, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
  }

  private key(text: string, task?: string): string {
    const hash = createHash("sha256").update(`${task || ""}:${text}`).digest("hex").slice(0, 24);
    return hash;
  }

  get(text: string, task?: string): number[] | undefined {
    const k = this.key(text, task);
    const entry = this.cache.get(k);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(k);
      this.misses++;
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(k);
    this.cache.set(k, entry);
    this.hits++;
    return entry.vector;
  }

  set(text: string, task: string | undefined, vector: number[]): void {
    const k = this.key(text, task);
    // Evict oldest if full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(k, { vector, createdAt: Date.now() });
  }

  get size(): number { return this.cache.size; }
  get stats(): { size: number; hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : "N/A",
    };
  }
}

// ============================================================================
// Types & Configuration
// ============================================================================

export interface EmbeddingConfig {
  provider: "openai-compatible" | "volcengine-multimodal";
  apiKey: string;
  model: string;
  baseURL?: string;
  dimensions?: number;

  /** Optional task type for query embeddings (e.g. "retrieval.query") */
  taskQuery?: string;
  /** Optional task type for passage/document embeddings (e.g. "retrieval.passage") */
  taskPassage?: string;
  /** Optional flag to request normalized embeddings (provider-dependent, e.g. Jina v5) */
  normalized?: boolean;
}

// Known embedding model dimensions
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "gemini-embedding-001": 3072,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "BAAI/bge-m3": 1024,
  "all-MiniLM-L6-v2": 384,
  "all-mpnet-base-v2": 768,

  // Jina v5
  "jina-embeddings-v5-text-small": 1024,
  "jina-embeddings-v5-text-nano": 768,
};

// ============================================================================
// Utility Functions
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export function getVectorDimensions(model: string, overrideDims?: number): number {
  if (overrideDims && overrideDims > 0) {
    return overrideDims;
  }

  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: ${model}. Either add it to EMBEDDING_DIMENSIONS or set embedding.dimensions in config.`
    );
  }

  return dims;
}

// ============================================================================
// Embedder Class
// ============================================================================

export class Embedder {
  private client: OpenAI;
  public readonly dimensions: number;
  private readonly _cache: EmbeddingCache;

  private readonly _model: string;
  private readonly _taskQuery?: string;
  private readonly _taskPassage?: string;
  private readonly _normalized?: boolean;
  private readonly _provider: "openai-compatible" | "volcengine-multimodal";

  constructor(config: EmbeddingConfig) {
    // Resolve environment variables in API key
    const resolvedApiKey = resolveEnvVars(config.apiKey);

    this._model = config.model;
    this._taskQuery = config.taskQuery;
    this._taskPassage = config.taskPassage;
    this._normalized = config.normalized;
    this._provider = config.provider || "openai-compatible";

    this.client = new OpenAI({
      apiKey: resolvedApiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });

    this.dimensions = getVectorDimensions(config.model, config.dimensions);
    this._cache = new EmbeddingCache(256, 30); // 256 entries, 30 min TTL
  }

  // --------------------------------------------------------------------------
  // Backward-compatible API
  // --------------------------------------------------------------------------

  /**
   * Backward-compatible embedding API.
   *
   * Historically the plugin used a single `embed()` method for both query and
   * passage embeddings. With task-aware providers we treat this as passage.
   */
  async embed(text: string): Promise<number[]> {
    return this.embedPassage(text);
  }

  /** Backward-compatible batch embedding API (treated as passage). */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embedBatchPassage(texts);
  }

  // --------------------------------------------------------------------------
  // Task-aware API
  // --------------------------------------------------------------------------

  async embedQuery(text: string): Promise<number[]> {
    return this.embedSingle(text, this._taskQuery);
  }

  async embedPassage(text: string): Promise<number[]> {
    return this.embedSingle(text, this._taskPassage);
  }

  async embedBatchQuery(texts: string[]): Promise<number[][]> {
    return this.embedMany(texts, this._taskQuery);
  }

  async embedBatchPassage(texts: string[]): Promise<number[][]> {
    return this.embedMany(texts, this._taskPassage);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private validateEmbedding(embedding: number[]): void {
    if (!Array.isArray(embedding)) {
      throw new Error(`Embedding is not an array (got ${typeof embedding})`);
    }
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`
      );
    }
  }

  private buildPayload(input: string | string[], task?: string): any {
    if (this._provider === "volcengine-multimodal") {
      // Volcengine multimodal API format
      const texts = Array.isArray(input) ? input : [input];
      return {
        model: this._model,
        input: texts.map((text) => ({
          type: "text",
          text,
        })),
      };
    }

    // Standard OpenAI-compatible format
    const payload: any = {
      model: this._model,
      input,
    };

    if (task) payload.task = task;
    if (this._normalized !== undefined) payload.normalized = this._normalized;

    return payload;
  }

  private async embedSingle(text: string, task?: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot embed empty text");
    }

    // Check cache first
    const cached = this._cache.get(text, task);
    if (cached) return cached;

    try {
      let embedding: number[] | undefined;

      if (this._provider === "volcengine-multimodal") {
        // Use custom fetch for volcengine multimodal API
        const response = await this.fetchVolcengineMultimodal([text]);
        embedding = response[0];
      } else {
        // Standard OpenAI-compatible API
        const response = await this.client.embeddings.create(this.buildPayload(text, task) as any);
        embedding = response.data[0]?.embedding as number[] | undefined;
      }

      if (!embedding) {
        throw new Error("No embedding returned from provider");
      }

      this.validateEmbedding(embedding);
      this._cache.set(text, task, embedding);
      return embedding;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to generate embedding: ${error.message}`, { cause: error });
      }
      throw new Error(`Failed to generate embedding: ${String(error)}`);
    }
  }

  private async fetchVolcengineMultimodal(texts: string[]): Promise<number[][]> {
    const baseURL = this.client.baseURL || "https://ark.cn-beijing.volces.com/api/v3";
    const url = `${baseURL}/embeddings/multimodal`;

    const payload = {
      model: this._model,
      input: texts.map((text) => ({
        type: "text",
        text,
      })),
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.client.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Volcengine API error: ${response.status} ${errorText}`);
    }

    const json = await response.json();
    // Volcengine multimodal API returns: {"created":..., "data":{"embedding":[...]}}
    // For single input, data is an object with embedding; for batch, data may be an array
    const data = (json as any).data;
    if (!data) {
      throw new Error(`Unexpected Volcengine response format: ${JSON.stringify(json).slice(0, 200)}`);
    }
    
    // Handle single embedding response
    if (data.embedding && Array.isArray(data.embedding)) {
      return [data.embedding];
    }
    
    // Handle array response
    if (Array.isArray(data)) {
      return data.map((item: any) => item.embedding || item);
    }
    
    throw new Error(`Unexpected Volcengine data format: ${JSON.stringify(data).slice(0, 200)}`);
  }

  private async embedMany(texts: string[], task?: string): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    // Filter out empty texts and track indices
    const validTexts: string[] = [];
    const validIndices: number[] = [];

    texts.forEach((text, index) => {
      if (text && text.trim().length > 0) {
        validTexts.push(text);
        validIndices.push(index);
      }
    });

    if (validTexts.length === 0) {
      return texts.map(() => []);
    }

    try {
      let embeddings: number[][];

      if (this._provider === "volcengine-multimodal") {
        // Use custom fetch for volcengine multimodal API
        embeddings = await this.fetchVolcengineMultimodal(validTexts);
      } else {
        // Standard OpenAI-compatible API
        const response = await this.client.embeddings.create(
          this.buildPayload(validTexts, task) as any
        );
        embeddings = response.data.map((item) => item.embedding as number[]);
      }

      // Create result array with proper length
      const results: number[][] = new Array(texts.length);

      // Fill in embeddings for valid texts
      embeddings.forEach((embedding, idx) => {
        const originalIndex = validIndices[idx];
        this.validateEmbedding(embedding);
        results[originalIndex] = embedding;
      });

      // Fill empty arrays for invalid texts
      for (let i = 0; i < texts.length; i++) {
        if (!results[i]) {
          results[i] = [];
        }
      }

      return results;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to generate batch embeddings: ${error.message}`, { cause: error });
      }
      throw new Error(`Failed to generate batch embeddings: ${String(error)}`);
    }
  }

  get model(): string {
    return this._model;
  }

  // Test connection and validate configuration
  async test(): Promise<{ success: boolean; error?: string; dimensions?: number }> {
    try {
      const testEmbedding = await this.embedPassage("test");
      return {
        success: true,
        dimensions: testEmbedding.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  get cacheStats() {
    return this._cache.stats;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return new Embedder(config);
}

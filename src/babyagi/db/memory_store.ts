import type { SQLiteDB } from "./sqlite_db";
import type { VectorDocument } from "../types";

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Simple deterministic text embedding fallback (TF-IDF / hashed n-gram) for offline / test usage
export function generateLocalEmbedding(text: string, dimensions: number = 64): number[] {
  const embedding = new Array(dimensions).fill(0);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);

  if (words.length === 0) return embedding;

  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash << 5) - hash + word.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dimensions;
    embedding[idx] += 1;
  }

  // Normalize
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    sumSq += embedding[i] * embedding[i];
  }
  const mag = Math.sqrt(sumSq);
  if (mag > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i] /= mag;
    }
  }

  return embedding;
}

export class MemoryStore {
  private db: SQLiteDB;

  constructor(db: SQLiteDB) {
    this.db = db;
  }

  public add(id: string, text: string, embedding?: number[], metadata?: Record<string, any>): void {
    const emb = embedding && embedding.length > 0 ? embedding : generateLocalEmbedding(text);
    this.db.saveVector(id, text, emb, metadata);
  }

  public search(queryEmbedding: number[], topK: number = 5): { document: VectorDocument; score: number }[] {
    const all = this.db.getAllVectors();
    const scored = all.map((doc) => ({
      document: doc,
      score: cosineSimilarity(queryEmbedding, doc.embedding)
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  public searchByText(text: string, topK: number = 5): { document: VectorDocument; score: number }[] {
    const queryEmb = generateLocalEmbedding(text);
    return this.search(queryEmb, topK);
  }

  public clear(): void {
    this.db.clearVectors();
  }
}

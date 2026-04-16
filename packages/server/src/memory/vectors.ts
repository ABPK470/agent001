import { getDb } from "../db.js"
import type { MemoryEntry, MemoryTier } from "./types.js"

// ── Vector embeddings (Ollama) ───────────────────────────────────

let ollamaAvailable: boolean | null = null

async function checkOllama(): Promise<boolean> {
  if (ollamaAvailable !== null) return ollamaAvailable
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2000) })
    ollamaAvailable = res.ok
  } catch {
    ollamaAvailable = false
  }
  return ollamaAvailable
}

async function getEmbedding(text: string): Promise<Float32Array | null> {
  if (!(await checkOllama())) return null
  try {
    const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", prompt: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json() as { embedding?: number[] }
    if (!data.embedding) return null
    return new Float32Array(data.embedding)
  } catch {
    return null
  }
}

export async function embedEntry(entry: MemoryEntry): Promise<void> {
  const embedding = await getEmbedding(entry.content)
  if (!embedding) return

  getDb().prepare(`
    INSERT OR REPLACE INTO memory_vectors (entry_id, embedding, dimension)
    VALUES (?, ?, ?)
  `).run(entry.id, Buffer.from(embedding.buffer), embedding.length)
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

export async function vectorSearch(
  query: string,
  limit = 10,
  tier?: MemoryTier,
): Promise<Array<{ entryId: string; similarity: number }>> {
  const queryVec = await getEmbedding(query)
  if (!queryVec) return []

  let sql = `
    SELECT v.entry_id, v.embedding, v.dimension, e.tier
    FROM memory_vectors v
    JOIN memory_entries e ON e.id = v.entry_id
  `
  const params: unknown[] = []
  if (tier) {
    sql += " WHERE e.tier = ?"
    params.push(tier)
  }

  const rows = getDb().prepare(sql).all(...params) as Array<{
    entry_id: string; embedding: Buffer; dimension: number; tier: string
  }>

  const scored = rows.map((row) => {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension)
    return { entryId: row.entry_id, similarity: cosineSimilarity(queryVec, vec) }
  })

  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, limit)
}

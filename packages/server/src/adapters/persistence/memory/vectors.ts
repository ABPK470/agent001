import { getDb } from "../sqlite.js"
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
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { embedding?: number[] }
    if (!data.embedding) return null
    return new Float32Array(data.embedding)
  } catch {
    return null
  }
}

export async function embedEntry(entry: MemoryEntry): Promise<void> {
  const embedding = await getEmbedding(entry.content)
  if (!embedding) return

  // Mirror upn + shared from the entry so vectorSearch can apply the tenant
  // filter inside SQL (defence-in-depth + correct recall when one tenant's
  // rows would otherwise dominate the cosine top-K).
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO memory_vectors (entry_id, embedding, dimension, upn, shared)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .run(entry.id, Buffer.from(embedding.buffer), embedding.length, entry.upn ?? null, entry.shared ? 1 : 0)
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    magA = 0,
    magB = 0
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
  /**
   * Tenant scope. `undefined` = no filter (admin / migration code).
   * `null` = legacy/unowned pool only. A string = that user's rows + shared=1.
   * Pushed into SQL so a chatty tenant cannot starve other tenants of recall.
   */
  upn?: string | null,
  sessionId?: string | null
): Promise<Array<{ entryId: string; similarity: number }>> {
  const queryVec = await getEmbedding(query)
  if (!queryVec) return []

  let sql = `
    SELECT v.entry_id, v.embedding, v.dimension, e.tier
    FROM memory_vectors v
    JOIN memory_entries e ON e.id = v.entry_id
  `
  const where: string[] = []
  const params: unknown[] = []
  if (tier) {
    where.push("e.tier = ?")
    params.push(tier)
  }
  if (upn !== undefined) {
    if (upn === null) {
      where.push("(v.upn IS NULL OR v.shared = 1)")
      // Temporary anonymous isolation: only the current sid can see its
      // private episodic vector rows. Shared rows remain global.
      if (tier === "episodic") {
        if (sessionId) {
          where.push("(v.shared = 1 OR e.session_id = ?)")
          params.push(sessionId)
        } else {
          where.push("v.shared = 1")
        }
      } else if (!tier) {
        if (sessionId) {
          where.push("(e.tier != 'episodic' OR v.shared = 1 OR e.session_id = ?)")
          params.push(sessionId)
        } else {
          where.push("(e.tier != 'episodic' OR v.shared = 1)")
        }
      }
    } else if (sessionId) {
      // Sid-scope bridge — see retrieval.ts named-user predicate (Layer C C4).
      // Lets the welcome-modal flow keep continuity across the upn promotion
      // by including legacy anon rows from the same sid.
      where.push("(v.upn = ? OR v.shared = 1 OR (v.upn IS NULL AND e.session_id = ?))")
      params.push(upn, sessionId)
    } else {
      where.push("(v.upn = ? OR v.shared = 1)")
      params.push(upn)
    }
  }
  if (where.length > 0) sql += " WHERE " + where.join(" AND ")

  const rows = getDb()
    .prepare(sql)
    .all(...params) as Array<{
    entry_id: string
    embedding: Buffer
    dimension: number
    tier: string
  }>

  const scored = rows.map((row) => {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension)
    return { entryId: row.entry_id, similarity: cosineSimilarity(queryVec, vec) }
  })

  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, limit)
}

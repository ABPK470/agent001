import { MemoryTier } from "../../../../../internal/enums/memory.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync } from "../../../schema/execute-async.js"
import type { MemoryEntry } from "./types.js"

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
  const db = getPlatformDb()
  await runExecAsync(
    db
      .deleteFrom("memory_vectors")
      .where("entry_id", "=", entry.id)
      .compile()
  )
  await runExecAsync(
    db
      .insertInto("memory_vectors")
      .values({
        entry_id: entry.id,
        embedding: Buffer.from(embedding.buffer),
        dimension: embedding.length,
        upn: entry.upn ?? null,
        shared: entry.shared ? 1 : 0
      })
      .compile()
  )
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
  threadId?: string | null
): Promise<Array<{ entryId: string; similarity: number }>> {
  const queryVec = await getEmbedding(query)
  if (!queryVec) return []

  let statement = getPlatformDb()
    .selectFrom("memory_vectors as v")
    .innerJoin("memory_entries as e", "e.id", "v.entry_id")
    .select(["v.entry_id", "v.embedding", "v.dimension", "e.tier"])
  if (tier) {
    statement = statement.where("e.tier", "=", tier)
  }
  if (tier === MemoryTier.Working && threadId && upn) {
    statement = statement.where(
      "e.run_id",
      "in",
      getPlatformDb().selectFrom("runs").select("id").where("thread_id", "=", threadId).where("upn", "=", upn)
    )
  }
  if (upn !== undefined) {
    if (upn === null) {
      statement = statement.where((eb) => eb.or([eb("v.upn", "is", null), eb("v.shared", "=", 1)]))
    } else {
      statement = statement.where((eb) => eb.or([eb("v.upn", "=", upn), eb("v.shared", "=", 1)]))
    }
  }
  const rows = await runAllAsync<{
    entry_id: string
    embedding: Buffer
    dimension: number
    tier: string
  }>(statement.compile())

  const scored = rows.map((row) => {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension)
    return { entryId: row.entry_id, similarity: cosineSimilarity(queryVec, vec) }
  })

  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, limit)
}

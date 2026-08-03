import type { MemoryRole, MemorySource, MemoryTier } from "./types.js"
import type { MemoryEntry } from "./types.js"

/** Translate a platform-store row into the memory domain shape. */
export function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    tier: row.tier as MemoryTier,
    role: (row.role as MemoryRole) ?? "assistant",
    content: row.content as string,
    metadata:
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : ((row.metadata as Record<string, unknown>) ?? {}),
    source: (row.source as MemorySource) ?? "agent",
    confidence: Number(row.confidence ?? 0.5),
    salience: Number(row.salience ?? 0.5),
    accessCount: Number(row.access_count ?? 0),
    runId: (row.run_id as string) ?? null,
    parentId: (row.parent_id as string) ?? null,
    upn: (row.upn as string) ?? null,
    shared: Number(row.shared ?? 0) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

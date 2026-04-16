// ── Types ────────────────────────────────────────────────────────

export type MemoryTier = "working" | "episodic" | "semantic"
export type MemorySource = "system" | "tool" | "user" | "agent" | "external"
export type MemoryRole = "user" | "assistant" | "tool" | "system" | "summary"

export interface MemoryEntry {
  id: string
  tier: MemoryTier
  role: MemoryRole
  content: string
  metadata: Record<string, unknown>
  source: MemorySource
  confidence: number
  salience: number
  accessCount: number
  sessionId: string | null
  runId: string | null
  parentId: string | null
  createdAt: string
  updatedAt: string
}

export interface ProceduralMemory {
  id: string
  trigger: string
  toolSequence: Array<{ tool: string; argsPattern: Record<string, unknown> }>
  successCount: number
  failureCount: number
  runId: string
  createdAt: string
  updatedAt: string
}

export interface UnifiedSearchResult {
  entry: MemoryEntry
  relevance: number
  recency: number
  combined: number
}

export interface MemoryBudget {
  maxTokens: number
  maxItems: number
}

// ── Compat aliases (consumed by routes/memory.ts) ────────────────

/** @deprecated Use MemoryEntry */
export interface Memory {
  id: string
  tier: MemoryTier | "procedural"
  content: string
  metadata: Record<string, unknown>
  source: MemorySource
  confidence: number
  accessCount: number
  runId: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}

export function entryToLegacy(e: MemoryEntry): Memory {
  return {
    id: e.id,
    tier: e.tier,
    content: e.content,
    metadata: e.metadata,
    source: e.source,
    confidence: e.confidence,
    accessCount: e.accessCount,
    runId: e.runId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    expiresAt: null,
  }
}

import { MemoryTier } from "../../../enums/memory.js"
import { MemoryRole } from "../../../enums/memory.js"
import { MemorySource } from "../../../enums/memory.js"
// ── Types ────────────────────────────────────────────────────────

export { MemoryTier }
export { MemorySource }
export { MemoryRole }

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
  /**
   * UPN of the user who owned the run that produced this entry. Null for
   * legacy / pre-tenancy rows and for service-internal ingests. Retrieval
   * paths filter by upn so user A's distilled knowledge cannot leak into
   * user B's prompt context. Use `shared=true` to opt a row into the
   * cross-user pool (admin-curated knowledge).
   */
  upn: string | null
  /**
   * When true the entry is visible to all users (admin-curated shared
   * knowledge). False by default. There is no UI/tool to set this yet —
   * leave dormant to avoid recreating the leak we just closed.
   */
  shared: boolean
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
  upn: string | null
  sessionId: string | null
  shared: boolean
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
    expiresAt: null
  }
}

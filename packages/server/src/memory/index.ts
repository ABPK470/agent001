/**
 * Unified Memory System — agenc-core inspired 3-tier retrieval.
 *
 * Architecture:
 *   All context flows through ONE retrieval pipeline. No separate "history" pipe.
 *   Recent turns naturally surface via recency scoring. Old knowledge competes
 *   via relevance. Everything is a memory entry at a different age and confidence.
 *
 * Tiers (budget-weighted retrieval):
 *   1. Working  (34%) — raw turns from current/recent sessions (high recency)
 *   2. Episodic (22%) — session summaries, compacted fragments (medium age)
 *   3. Semantic (44%) — long-lived consolidated knowledge (high relevance)
 *
 * Modules:
 *   types.ts         — shared types and interfaces
 *   scoring.ts       — constants, salience, decay, dedup, FTS sanitization
 *   schema.ts        — DB schema migration and row mappers
 *   vectors.ts       — Ollama vector embeddings
 *   ingestion.ts     — ingestTurn, ingestRunTurns
 *   procedural.ts    — tool-sequence procedural memory
 *   retrieval.ts     — retrieveContext, searchEntries (hybrid FTS5 + vector)
 *   consolidation.ts — episodic → semantic promotion pipeline
 *   maintenance.ts   — prune, stats, CRUD helpers
 */

export type {
    Memory,
    MemoryBudget,
    MemoryEntry,
    MemoryRole,
    MemorySource,
    MemoryTier,
    ProceduralMemory,
    UnifiedSearchResult
} from "./types.js"

export { consolidate } from "./consolidation.js"
export { flagRunMemory, ingestRunTurns, ingestTurn } from "./ingestion.js"
export { clearAllMemories, deleteMemory, getMemory, getMemoryStats, listMemories, prune } from "./maintenance.js"
export { extractProcedural, markProceduralFailed, searchProcedures, storeProcedural } from "./procedural.js"
export { retrieveContext, searchEntries } from "./retrieval.js"
export { migrateMemory } from "./schema.js"
export { vectorSearch } from "./vectors.js"


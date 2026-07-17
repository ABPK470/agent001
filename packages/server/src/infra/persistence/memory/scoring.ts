import type { MemoryBudget, MemoryRole, MemorySource, MemoryTier } from "./types.js"

// ── Constants ────────────────────────────────────────────────────

export const RECENCY_HALF_LIFE_H = 24
export const DECAY_HALF_LIFE_DAYS = 7
export const RECENCY_WEIGHT = 0.4
export const SALIENCE_THRESHOLD = 0.15
/**
 * Working memory is scoped to an active session window.
 * Entries older than this are excluded from working-tier retrieval so that answers
 * from a conversation last week don't bleed into a fresh run today.
 * Episodic/semantic tiers are unaffected — they have their own decay mechanisms.
 */
export const WORKING_SESSION_WINDOW_H = 4
export const DEDUP_JACCARD_THRESHOLD = 0.86
/** Minimum combined score for a memory to be included in context. */
export const RELEVANCE_THRESHOLD = 0.15
export const DEFAULT_BUDGET: MemoryBudget = { maxTokens: 3000, maxItems: 15 }

export const TIER_BUDGET: Record<MemoryTier, number> = {
  working: 0.34,
  episodic: 0.22,
  semantic: 0.44
}

export const SOURCE_WEIGHT: Record<MemorySource, number> = {
  system: 1.0,
  tool: 0.85,
  user: 0.7,
  agent: 0.55,
  external: 0.4
}

// ── Salience scoring ─────────────────────────────────────────────

const ACTION_KEYWORDS = new Set([
  "create",
  "created",
  "build",
  "built",
  "deploy",
  "deployed",
  "fix",
  "fixed",
  "debug",
  "debugged",
  "implement",
  "implemented",
  "decide",
  "decided",
  "configure",
  "configured",
  "install",
  "installed",
  "write",
  "wrote",
  "delete",
  "deleted",
  "update",
  "updated",
  "run",
  "execute",
  "test",
  "tested",
  "refactor",
  "refactored",
  "error",
  "failed",
  "success",
  "completed",
  "migrate",
  "migrated"
])

export function computeSalience(content: string, role: MemoryRole): number {
  if (role === "system") return 0.8

  const len = content.length
  const lengthScore = Math.min(1, len / 200) * 0.35

  const words = content.toLowerCase().split(/\s+/)
  const actionHits = words.filter((w) => ACTION_KEYWORDS.has(w)).length
  const actionScore = Math.min(1, actionHits / 3) * 0.4

  let structureScore = 0
  if (/```/.test(content)) structureScore += 0.4
  if (/\/[\w.-]+\/[\w.-]+/.test(content)) structureScore += 0.3
  if (/https?:\/\//.test(content)) structureScore += 0.15
  if (/\b\w+\.\w{1,4}\b/.test(content)) structureScore += 0.15
  structureScore = Math.min(1, structureScore) * 0.25

  return lengthScore + actionScore + structureScore
}

// ── Text truncation ──────────────────────────────────────────────

/** Truncate text at the last complete line boundary within maxLen. */
export function truncateAtBoundary(text: string, maxLen: number, suffix = ""): string {
  if (text.length <= maxLen) return text
  const lastNewline = text.lastIndexOf("\n", maxLen)
  if (lastNewline > maxLen * 0.5) {
    return text.slice(0, lastNewline) + suffix
  }
  const lastSentence = Math.max(
    text.lastIndexOf(". ", maxLen),
    text.lastIndexOf("! ", maxLen),
    text.lastIndexOf("? ", maxLen)
  )
  if (lastSentence > maxLen * 0.5) {
    return text.slice(0, lastSentence + 1) + suffix
  }
  const lastSpace = text.lastIndexOf(" ", maxLen)
  if (lastSpace > maxLen * 0.5) {
    return text.slice(0, lastSpace) + suffix
  }
  return text.slice(0, maxLen) + suffix
}

// ── Deduplication ────────────────────────────────────────────────

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
  )
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  return intersection / (a.size + b.size - intersection)
}

export function isDuplicate(content: string, recentContents: string[]): boolean {
  const tokens = tokenize(content)
  for (const rc of recentContents) {
    if (jaccardSimilarity(tokens, tokenize(rc)) >= DEDUP_JACCARD_THRESHOLD) return true
  }
  return false
}

// ── Recency & Decay ──────────────────────────────────────────────

export function recencyScore(createdAt: string, now: Date = new Date()): number {
  const ageMs = now.getTime() - new Date(createdAt).getTime()
  const ageH = ageMs / (1000 * 60 * 60)
  return Math.exp(-ageH / RECENCY_HALF_LIFE_H)
}

export function confidenceDecay(createdAt: string, now: Date = new Date()): number {
  const ageMs = now.getTime() - new Date(createdAt).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS)
}

/**
 * ACT-R inspired activation (agenc-core pattern).
 * Frequently accessed + recently accessed memories stay most relevant.
 *
 * activation = (1 + log(accessCount + 1)) / 7 × accessRecency
 * accessRecency is 1.0 for just-accessed, decays exponentially.
 */
export function activationBonus(accessCount: number, updatedAt?: string, now?: Date): number {
  const base = (1 + Math.log(accessCount + 1)) / 7
  if (!updatedAt) return base
  const ageMs = (now ?? new Date()).getTime() - new Date(updatedAt).getTime()
  const ageH = ageMs / (1000 * 60 * 60)
  const accessRecency = Math.exp(-ageH / (RECENCY_HALF_LIFE_H * 2))
  return base * (0.5 + 0.5 * accessRecency)
}

// ── FTS query sanitization ───────────────────────────────────────

export function sanitizeFtsQuery(query: string): string {
  const cleaned = query
    .replace(/[*"():^{}[\]\\]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .trim()

  if (!cleaned) return ""

  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 20)

  if (tokens.length === 0) return ""

  return tokens.map((t) => `"${t}"`).join(" OR ")
}

/** Single-token queries are usually marker lookups — vector-only hits must include the term literally. */
export function vectorAugmentationMatchesQuery(query: string, content: string): boolean {
  const needle = query.trim()
  if (!needle) return true
  if (/\s/.test(needle)) return true
  return content.toLowerCase().includes(needle.toLowerCase())
}

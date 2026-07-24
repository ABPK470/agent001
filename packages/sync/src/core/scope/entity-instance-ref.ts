/**
 * Normalize user/agent references to a sync entity row (recipe root table).
 * Distinguishes numeric primary keys from display-name fragments.
 */

export interface ParsedEntityInstanceRef {
  /** Numeric or string primary key when confidently identified. */
  entityId: string | null
  /** Display-name search fragment when not a bare id. */
  entityQuery: string | null
}

const ID_KEY_RE =
  /^(?:table\s*id|tableid|table|id|entity\s*id|pk|meta\s*table\s*id)\s*[=:#]\s*([^\s,;]+)/i

const NOISE_TOKEN_RE = /^(?:table|row|record|entity|meta|gate|the|a|an|id|#)$/i

/**
 * Parse a free-text instance reference from a sync goal or search_sync_entities `q`.
 *
 * Examples:
 *   "2545" / "#2545"           → entityId
 *   "table 2545"               → entityId
 *   "tableId=2545" / "table=2545" → entityId
 *   "ACSRawTest" / "abcd"      → entityQuery
 *   "acrstest (#12334)"        → entityId (UI display label suffix)
 */
export function parseEntityInstanceRef(raw: string): ParsedEntityInstanceRef {
  const trimmed = raw.trim()
  if (!trimmed) return { entityId: null, entityQuery: null }

  const parenId = trimmed.match(/\(#\s*(\d+)\s*\)\s*$/)
  if (parenId?.[1]) return { entityId: parenId[1], entityQuery: null }

  const kv = trimmed.match(ID_KEY_RE)
  if (kv?.[1]) {
    const value = kv[1].trim()
    if (/^\d+$/.test(value)) return { entityId: value, entityQuery: null }
    return { entityId: null, entityQuery: value }
  }

  const bare = trimmed.replace(/^#/, "").trim()
  if (/^\d+$/.test(bare)) return { entityId: bare, entityQuery: null }

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const numericTokens = tokens.filter((t) => /^\d+$/.test(t.replace(/^#/, "")))
  if (numericTokens.length === 1) {
    const nonNumeric = tokens.filter((t) => !/^\d+$/.test(t.replace(/^#/, "")))
    if (nonNumeric.length === 0 || nonNumeric.every((t) => NOISE_TOKEN_RE.test(t))) {
      return { entityId: numericTokens[0]!.replace(/^#/, ""), entityQuery: null }
    }
  }

  return { entityId: null, entityQuery: trimmed }
}

/** Normalize API/UI entity ids — strips display labels like `acrstest (#12334)`. */
export function coerceSyncEntityId(raw: string | number): string | number {
  if (typeof raw === "number") return raw
  const parsed = parseEntityInstanceRef(raw)
  if (parsed.entityId) {
    return /^\d+$/.test(parsed.entityId) ? Number(parsed.entityId) : parsed.entityId
  }
  const bare = raw.trim()
  return /^\d+$/.test(bare) ? Number(bare) : bare
}

/** True when the value is still a display name (not a resolved primary key). */
export function isUnresolvedEntityName(entityId: string | number): boolean {
  const coerced = coerceSyncEntityId(entityId)
  if (typeof coerced === "number") return false
  return !/^\d+$/.test(String(coerced).trim())
}

export type EntitySearchHit = { id: string | number; name: string | null }

/**
 * Prefer exact label match; otherwise unique fuzzy hit.
 * Returns null when none; throws only via caller messaging for ambiguity.
 */
export function pickUniqueEntitySearchHit(
  query: string,
  hits: readonly EntitySearchHit[],
):
  | { ok: true; hit: EntitySearchHit }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "ambiguous"; hits: EntitySearchHit[] } {
  const needle = query.trim().toLowerCase()
  if (!needle || hits.length === 0) return { ok: false, reason: "none" }

  const exact = hits.filter((h) => (h.name ?? "").trim().toLowerCase() === needle)
  const candidates = exact.length > 0 ? exact : [...hits]
  if (candidates.length === 0) return { ok: false, reason: "none" }
  if (candidates.length > 1) return { ok: false, reason: "ambiguous", hits: candidates }
  return { ok: true, hit: candidates[0]! }
}

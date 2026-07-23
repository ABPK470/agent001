/**
 * Unified known-vocabulary helpers for goal classification and clarify.
 *
 * Sources (first principles):
 *   1. Tenant config — user-facing business words only (`domainKeywords`)
 *   2. Live catalog — schema names (never duplicated in tenant.json)
 *   3. Published sync bundle — entity type ids (never duplicated in tenant.json)
 */

import type { CatalogSchemaSource } from "../types/catalog-schema-source.js"
import type { TenantConfig } from "./tenant-config.js"

/** Lowercase schema names from the live catalog. */
export function catalogSchemaTokens(catalog: CatalogSchemaSource | null | undefined): string[] {
  if (!catalog) return []
  const out = new Set<string>()
  for (const [, t] of catalog.tables) out.add(t.schema.toLowerCase())
  return [...out].sort()
}

/** Tenant business words + published sync entity ids + catalog schemas. */
export function buildKnownVocabulary(
  tenant: TenantConfig,
  publishedIds: readonly string[],
  catalog?: CatalogSchemaSource | null
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const w of tenant.domainKeywords) out.add(w.toLowerCase())
  for (const key of Object.keys(tenant.catalogBootstrap.canonicalQualifiedNames).sort()) out.add(key.toLowerCase())
  for (const id of publishedIds) out.add(id.toLowerCase())
  for (const s of catalogSchemaTokens(catalog)) out.add(s)
  return out
}

/** True when `text` contains any whole-word tenant domain keyword. */
export function goalContainsDomainKeyword(text: string, domainKeywords: readonly string[]): boolean {
  const keywords = domainKeywords
  if (keywords.length === 0) return false
  const re = new RegExp(
    `\\b(?:${keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "i"
  )
  return re.test(text)
}

/** True when `text` contains a published sync entity type id as a whole word. */
export function goalContainsSyncEntityId(text: string, publishedIds: readonly string[]): boolean {
  const ids = publishedIds
  if (ids.length === 0) return false
  const re = new RegExp(
    `\\b(?:${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "i"
  )
  return re.test(text)
}

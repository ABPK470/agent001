// grain-undefined detector — "this period word matches multiple grain columns".
//
// Fires (warn-severity) when the goal mentions a period word ("monthly",
// "by month", "daily", etc.) AND the catalog has more than one plausible
// grain column in analytic schemas. Suppressed when the deployment has a
// canonical calendar path (dim.Date.pkMonth → dim.Month).
//
// Pure function of (goal, catalog). No I/O, no LLM.

import type { CatalogGraph } from "../../../tools/catalog/graph/index.js"
import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"

const VERSION = "1.1.0"

/**
 * Period roots — the canonical singular noun form the detector searches
 * for in column names. Each entry pairs the user-facing phrasing
 * regexes (matched in the goal) with the column-name substring to scan.
 */
const PERIOD_GROUPS: readonly { match: RegExp; root: string; label: string }[] = [
  { match: /\b(daily|by\s+day|per\s+day)\b/i, root: "day", label: "day" },
  { match: /\b(weekly|by\s+week|per\s+week)\b/i, root: "week", label: "week" },
  { match: /\b(monthly|by\s+month|per\s+month|months?)\b/i, root: "month", label: "month" },
  { match: /\b(quarterly|by\s+quarter|per\s+quarter)\b/i, root: "quarter", label: "quarter" },
  { match: /\b(yearly|annually|by\s+year|per\s+year)\b/i, root: "year", label: "year" }
]

const ANALYTIC_SCHEMAS = new Set(["dim", "publish", "persistedview", "fact", "list"])
const MAX_CANDIDATES = 6

function hasCanonicalMonthGrain(catalog: CatalogGraph): boolean {
  const monthTable = catalog.getTable("dim.Month") ?? catalog.getTable("dim.month")
  const dateTable = catalog.getTable("dim.Date") ?? catalog.getTable("dim.date")
  if (!monthTable || !dateTable) return false
  return dateTable.columns.some((c) => c.name.toLowerCase() === "pkmonth")
}

function grainColumnsForRoot(catalog: CatalogGraph, root: string): string[] {
  const out: string[] = []
  for (const [, table] of catalog.tables) {
    if (!ANALYTIC_SCHEMAS.has(table.schema.toLowerCase())) continue
    for (const col of table.columns) {
      const name = col.name.toLowerCase()
      if (!name.includes(root)) continue
      out.push(`${table.qualifiedName}.${col.name}`)
    }
  }
  return [...new Set(out)]
}

export const grainUndefinedDetector: Detector = {
  id: "grain-undefined",
  version: VERSION,

  detect(ctx) {
    if (!ctx.catalog) return []
    const out = []
    for (const group of PERIOD_GROUPS) {
      if (!group.match.test(ctx.goal)) continue

      if (group.root === "month" && hasCanonicalMonthGrain(ctx.catalog)) continue

      const matchingCols = grainColumnsForRoot(ctx.catalog, group.root)
      if (matchingCols.length < 2) continue

      const candidates = matchingCols
        .sort((a, b) => {
          const aDim = a.toLowerCase().startsWith("dim.") ? 0 : 1
          const bDim = b.toLowerCase().startsWith("dim.") ? 0 : 1
          if (aDim !== bDim) return aDim - bDim
          return a.localeCompare(b)
        })
        .slice(0, MAX_CANDIDATES)

      out.push({
        id: makeFindingId("grain-undefined", group.label),
        kind: "grain-undefined" as const,
        severity: "warn" as const,
        subject: group.label,
        reasoning:
          group.root === "month"
            ? `"${group.label}" grain is ambiguous across analytic tables. Default is reporting month via dim.Date.pkMonth joined to dim.Month unless you need accounting month.`
            : `"${group.label}" grain is ambiguous: ${matchingCols.length} columns match that period in analytic schemas.`,
        candidates,
        uiOptions: candidates,
        suggestedQuestion:
          group.root === "month"
            ? `For "${group.label}" grouping, should I use reporting month (dim.Date.pkMonth → dim.Month) or accounting month?`
            : `For "${group.label}" grouping, which column should I use?`,
        source: "detector" as const
      })
    }
    return out
  }
}

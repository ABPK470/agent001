// Doctrine: big-view touch budget.
//
// Every object the live catalog classifies as "large" (rowCount or
// viewSourceRows ≥ tenant threshold — wide UNION views, partitioned
// fact tables, …) must be touched at most twice per task. The
// validator already blocks at >2 references via
// countReferencedLargeObjects(); this module surfaces the rule in one
// citable place for the prompt and for traces. The example list of
// objects is sampled from the live catalog so there is nothing
// customer-specific hardcoded here.

import { countReferencedLargeObjects } from "../../tools/database/mssql/validation.js"
import { listLargeObjects } from "../../tools/catalog/queries.js"
import type { DoctrineModule } from "./types.js"

export const bigViewBudgetDoctrine: DoctrineModule = {
  id: "mssql.big-view-budget",
  version: "1.1.0",
  summaryBudgetBytes: 480,
  summary(): string {
    const samples = [...listLargeObjects()].slice(0, 3)
    const exampleList = samples.length > 0 ? samples.join(", ") : "the live catalog's largest tables/views"
    return [
      "Big-view touch budget (enforced):",
      `- Touch each large object (e.g. ${exampleList}) at most TWICE per task.`,
      "- Stage 1: narrow keys into #temp (one touch). Stage 2: fetch detail rows for those keys (second touch).",
      "- Derive every remaining metric from #temp only. The tool BLOCKS queries with >2 references to any large object."
    ].join("\n")
  },
  enforce(query: string) {
    const counts = countReferencedLargeObjects(query)
    const offenders = Array.from(counts.entries()).filter(([, count]) => count > 2)
    if (offenders.length === 0) return []
    const list = offenders.map(([name, count]) => `${name} (${count})`).join(", ")
    return [
      {
        code: "large_object_overused",
        severity: "block" as const,
        message: `Large object referenced more than twice: ${list}.`
      }
    ]
  }
}

// Doctrine: big-view touch budget.
//
// publish.Revenue, publish.Balances and other large UNION views must
// be touched at most twice per task. The validator already blocks at
// >2 references via countReferencedLargeObjects(); this module surfaces
// the rule in one citable place for the prompt and for traces.

import { countReferencedLargeObjects } from "../tools/mssql/validation.js"
import type { DoctrineModule } from "./types.js"

export const bigViewBudgetDoctrine: DoctrineModule = {
  id: "mssql.big-view-budget",
  version: "1.0.0",
  summaryBudgetBytes: 480,
  summary(): string {
    return [
      "Big-view touch budget (enforced):",
      "- Touch each large object (publish.Revenue, publish.Balances, fact.*) at most TWICE per task.",
      "- Stage 1: narrow keys into #temp (one touch). Stage 2: fetch detail rows for those keys (second touch).",
      "- Derive every remaining metric from #temp only. The tool BLOCKS queries with >2 references to any large object.",
    ].join("\n")
  },
  enforce(query: string) {
    const counts = countReferencedLargeObjects(query)
    const offenders = Array.from(counts.entries()).filter(([, count]) => count > 2)
    if (offenders.length === 0) return []
    const list = offenders.map(([name, count]) => `${name} (${count})`).join(", ")
    return [{
      code: "large_object_overused",
      severity: "block" as const,
      message: `Large object referenced more than twice: ${list}.`,
    }]
  },
}

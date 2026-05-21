// Doctrine: publish.Revenue / publish.Balances branch-local aggregation.
//
// publish.Revenue is a UNION ALL of ~59 source-mapping views (per
// deploy/mssql/lineage.json). A persistedView mirror is NOT always
// present. The correct shape is branch-local aggregation: aggregate
// inside each source branch first, UNION the per-branch aggregates,
// then rank. This is documented prose today; this module is the
// citable rule and the anchor for a future compose_revenue_topn tool.

import type { DoctrineModule } from "./types.js"

export const revenueBalancesPolicyDoctrine: DoctrineModule = {
  id: "mssql.revenue-balances-policy",
  version: "1.0.0",
  summaryBudgetBytes: 720,
  summary(): string {
    return [
      "publish.Revenue / publish.Balances shape policy:",
      "- Both are UNION ALL views over many source-mapping views (Revenue ≈59 branches).",
      "- Prefer persistedView.[publish.X] ONLY when that exact mirror exists in the live catalog.",
      "- When no mirror exists, do branch-local aggregation: aggregate inside each required source branch first (SELECT pkClient, SUM(...) FROM publish.<Branch> WHERE ... GROUP BY pkClient), UNION ALL the per-branch results, then re-aggregate / rank.",
      "- Never SELECT * FROM publish.Revenue without a narrowing predicate; the unfiltered scan touches every branch.",
      "- Branch names come from curated lineage (deploy/mssql/lineage.json), not from guessing.",
    ].join("\n")
  },
}

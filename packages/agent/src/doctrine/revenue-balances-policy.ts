// Doctrine: publish.Revenue / publish.Balances branch-local aggregation.
//
// publish.Revenue is a UNION ALL of ~59 source-mapping views (per
// deploy/mssql/lineage.json). A persistedView mirror is NOT always
// present. The correct shape is branch-local aggregation: aggregate
// inside each source branch first, UNION the per-branch aggregates,
// then rank. Validator enforces via detectPublishViewTopnWithoutBranchAggregation();
// this module is the citable rule body and prompt summary.

import { detectPublishViewTopnWithoutBranchAggregation } from "../tools/mssql/validation.js"
import { DOCTRINE_FIX_HINTS } from "./fix-hints.js"
import type { DoctrineModule } from "./types.js"

export const revenueBalancesPolicyDoctrine: DoctrineModule = {
  id: "mssql.revenue-balances-policy",
  version: "1.1.0",
  summaryBudgetBytes: 800,
  summary(): string {
    return [
      "publish.Revenue / publish.Balances shape policy (enforced):",
      "- Both are UNION ALL views over many source-mapping views (Revenue ≈59 branches).",
      "- Prefer persistedView.[publish.X] ONLY when that exact mirror exists in the live catalog.",
      "- When no mirror exists, do branch-local aggregation: aggregate inside each required source branch first (SELECT pkClient, SUM(...) FROM publish.<Branch> WHERE ... GROUP BY pkClient), UNION ALL the per-branch results, then re-aggregate / rank.",
      "- The tool BLOCKS a direct `TOP N … FROM publish.Revenue|Balances … GROUP BY pkClient/pkAccount` — that shape forces global expansion of every UNION branch and always times out.",
      "- Branch names come from curated lineage: `search_catalog lineage=publish.Revenue`. Do NOT guess.",
    ].join("\n")
  },
  enforce(query: string) {
    const offender = detectPublishViewTopnWithoutBranchAggregation(query)
    if (!offender) return []
    return [{
      code: "publish_view_topn_without_branch_aggregation",
      severity: "block" as const,
      message: [
        `Query blocked — direct TOP-N + GROUP BY ${offender.groupKey} against ${offender.object}.`,
        ``,
        `${offender.object} is a UNION ALL over many source-mapping views. A single GROUP BY ${offender.groupKey} + TOP N forces SQL Server to expand every branch, materialise the lot, then group and sort globally. No branch-local index can help — this shape runs for minutes.`,
      ].join("\n"),
      fixHint: DOCTRINE_FIX_HINTS.publish_view_topn_without_branch_aggregation,
    }]
  },
}

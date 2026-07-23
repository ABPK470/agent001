// Doctrine: wide-union-view branch-local aggregation.
//
// Any VIEW the catalog classifies as a wide UNION (≥ tenantConfig.unionBranchThreshold
// source branches) cannot be ranked with a direct `TOP N … GROUP BY <high-cardinality-key>`.
// The optimiser is forced to expand every branch, materialise the union and
// then group/sort globally — no branch-local index can help. The correct
// shape is branch-local aggregation: aggregate INSIDE each source branch
// first, UNION ALL the per-branch results, then re-aggregate and rank.
//
// The summary's "wide views in this catalog" sample is derived from the
// LIVE catalog at prompt-build time, so no customer-specific name is
// hardcoded here — the doctrine activates on the SHAPE the catalog reports.

import {
  detectWideUnionViewTopnWithoutBranchAggregation
} from "../../tools/database/mssql/validation.js"
import { listExpensiveUnionViews, unionBranchCount } from "../../tools/catalog/queries.js"
import { DOCTRINE_FIX_HINTS } from "./fix-hints.js"
import type { DoctrineModule } from "./types.js"

export const wideUnionViewPolicyDoctrine: DoctrineModule = {
  id: "mssql.wide-union-view-policy",
  version: "1.3.0",
  // 1024B (raised from 900B in v1.3.0 to fit the Plan v3 Phase 7
  // compareMirror cross-reference; still well under the 2560B total
  // doctrine-block budget).
  summaryBudgetBytes: 1024,
  summary(): string {
    const wide = [...listExpensiveUnionViews()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([qn, branches]) => `${qn} (~${branches} branches)`)
    const examples =
      wide.length > 0
        ? wide.join("; ")
        : "every view the live catalog reports as a wide UNION (none present in this catalog)"
    return [
      "Wide UNION view shape policy (enforced):",
      `- The live catalog classifies these views as wide UNIONs: ${examples}.`,
      "- Prefer the persisted mirror (when one exists in the catalog under the configured mirror schema).",
      "- BEFORE substituting `<mirrorSchema>.X` for `X`, call `profile_data(compareMirror=true)` against the candidate; substitute only when the tool's recommendation is `USE_MIRROR`.",
      "- When no mirror exists, do branch-local aggregation: aggregate inside each required source branch first (`SELECT <keyCol>, SUM(<metric>) FROM <branch> WHERE … GROUP BY <keyCol>`), UNION ALL the per-branch results, then re-aggregate / rank.",
      "- The tool BLOCKS a direct `TOP N … FROM <wide-union-view> … GROUP BY <high-cardinality-key>` — that shape forces global expansion of every UNION branch and always times out.",
      "- Branch names come from curated lineage: `search_catalog lineage=<wide-union-view>`. Do NOT guess."
    ].join("\n")
  },
  enforce(query: string) {
    const offender = detectWideUnionViewTopnWithoutBranchAggregation(query)
    if (!offender) return []
    const branches = offender.branchCount || unionBranchCount(offender.object)
    return [
      {
        code: "publish_view_topn_without_branch_aggregation",
        severity: "block" as const,
        message: [
          `Query blocked — direct TOP-N + GROUP BY ${offender.groupKey} against ${offender.object}.`,
          ``,
          `${offender.object} is a UNION ALL over ${branches} source-mapping views (per live catalog). A single GROUP BY ${offender.groupKey} + TOP N forces SQL Server to expand every branch, materialise the lot, then group and sort globally. No branch-local index can help — this shape runs for minutes.`
        ].join("\n"),
        fixHint: DOCTRINE_FIX_HINTS.publish_view_topn_without_branch_aggregation
      }
    ]
  }
}

/**
 * Back-compat alias. Older imports referenced `revenueBalancesPolicyDoctrine`.
 * Keep the name resolvable while the rename propagates through the tree.
 *
 * @deprecated Use `wideUnionViewPolicyDoctrine`.
 */
export const revenueBalancesPolicyDoctrine = wideUnionViewPolicyDoctrine

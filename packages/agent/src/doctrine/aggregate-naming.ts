// Doctrine: aggregate-function ↔ output-alias semantic agreement.
//
// SUM(x) AS Avg…, AVG(x) AS Total…, COUNT(x) AS Avg…, etc. are blocked
// because the function and the alias disagree on what the number means.
// Validator already implements the structural check in
// findAggregateSemanticIssues(); this module is the citable rule body.

import { AggregateSeverity } from "../domain/enums/sql-guard.js"
import { findAggregateSemanticIssues } from "../tools/mssql/validation.js"
import { DOCTRINE_FIX_HINTS } from "./fix-hints.js"
import type { DoctrineModule } from "./types.js"

export const aggregateNamingDoctrine: DoctrineModule = {
  id: "mssql.aggregate-naming",
  version: "1.0.0",
  summaryBudgetBytes: 560,
  summary(): string {
    return [
      "Aggregate ↔ alias agreement (enforced):",
      "- The aggregate function and the output column alias MUST agree (SUM→Total/Sum, AVG→Avg/Mean, COUNT→Count).",
      "- SUM(x) AS Avg… or AVG(x) AS Total… is BLOCKED — silently returns N× the real value.",
      "- Snapshot/pre-averaged cols (Average/Avg/Mean/Spot/EOM/Latest/Snapshot/AsOf): AVG, not SUM. MTD/YTD/QTD/WTD = row-grain period slices — SUM within their period key.",
      "- Confirm with `profile_data`; record with `note` (category=column_semantics).",
    ].join("\n")
  },
  enforce(query: string) {
    return findAggregateSemanticIssues(query)
      .filter((issue) => issue.severity === AggregateSeverity.Block)
      .map((issue) => ({
        code: "aggregate_semantic_mismatch",
        severity: "block" as const,
        message: [
          `Query blocked — aggregate-semantic mismatch on line ${issue.line}:`,
          ``,
          `    ${issue.snippet}`,
          ``,
          issue.message,
        ].join("\n"),
        fixHint: DOCTRINE_FIX_HINTS.aggregate_semantic_mismatch,
      }))
  },
}

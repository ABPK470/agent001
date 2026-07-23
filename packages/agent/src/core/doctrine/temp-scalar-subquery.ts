// Doctrine: don't re-probe staged #temp tables with repeated scalar
// subqueries.
//
// The trace pathology this rule blocks (verbatim, from production):
//   SELECT ...,
//     (SELECT COUNT(*)        FROM #revLines_x WHERE r.pkClient = t.pkClient),
//     (SELECT SUM(...)        FROM #revLines_x WHERE r.pkClient = t.pkClient),
//     (SELECT TOP 1 ProductName FROM ... JOIN #revLines_x ...)
//   FROM #topClients_x t ...
//
// Each scalar subquery re-scans the staged temp once per output row.
// Stage 2 of the micro-ETL pattern is supposed to stage detail ROWS;
// Stage 3 is supposed to aggregate those rows ONCE per business key
// and join the small grouped result. Repeatedly probing the temp
// turns a constant-time Stage 3 into an N×M Stage 3 and undoes the
// whole point of staging.
//
// Validator already implements the structural detection in
// countTempScalarSubqueriesByTemp(); this module is the citable
// rule body and the doctrine-owned fixHint.

import { countTempScalarSubqueriesByTemp } from "../../tools/database/mssql/validation.js"
import { DOCTRINE_FIX_HINTS } from "./fix-hints.js"
import type { DoctrineModule } from "./types.js"

export const tempScalarSubqueryDoctrine: DoctrineModule = {
  id: "mssql.temp-scalar-subquery",
  version: "1.0.0",
  summaryBudgetBytes: 560,
  summary(): string {
    return [
      "Repeated #temp scalar-subquery probes (enforced):",
      "- A single #temp may be probed with a scalar subquery (SELECT … FROM #t WHERE …) at most ONCE per outer query.",
      "- Multiple metrics from the same staged #temp MUST be derived in one GROUP BY pkClient pass, then joined.",
      "- The tool BLOCKS queries with ≥2 scalar subqueries against the same staged #temp.",
      "- See also: `discover_relationships` to pick the right GROUP BY key; `profile_data` to size the staged set before fan-out."
    ].join("\n")
  },
  enforce(query: string) {
    const counts = countTempScalarSubqueriesByTemp(query)
    const offenders = Array.from(counts.entries()).filter(([, count]) => count > 1)
    if (offenders.length === 0) return []
    const list = offenders.map(([name, count]) => `${name} (${count} scalar probes)`).join(", ")
    return [
      {
        code: "temp_scalar_subquery_overused",
        severity: "block" as const,
        message: [
          `Query blocked — repeated scalar subqueries against staged #temp data: ${list}.`,
          ``,
          `This shape repeatedly re-probes staged rows one metric at a time and is exactly the pattern that turns a good micro-ETL into a slow Stage 3 plan.`
        ].join("\n"),
        fixHint: DOCTRINE_FIX_HINTS.temp_scalar_subquery_overused
      }
    ]
  }
}

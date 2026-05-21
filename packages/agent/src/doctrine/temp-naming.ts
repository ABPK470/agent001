// Doctrine: local #temp table naming integrity.
//
// Authoritative rule body lives here. Validator delegates structural
// enforcement to validateTempTableBatch(); this module wraps it so the
// rule is citable from one place and the prompt summary stays in sync
// with what the validator actually blocks.

import { validateTempTableBatch } from "../tools/mssql/validation.js"
import { DOCTRINE_FIX_HINTS } from "./fix-hints.js"
import type { DoctrineModule } from "./types.js"

export const tempNamingDoctrine: DoctrineModule = {
  id: "mssql.temp-naming",
  version: "1.0.0",
  summaryBudgetBytes: 480,
  summary(): string {
    return [
      "Local #temp naming (enforced):",
      "- Every #temp ends with an 8-hex suffix (e.g. #range_a3f91c08).",
      "- Exactly one suffix is reused across the whole batch.",
      "- Every referenced #temp must be created in the same batch; DROP each at the end.",
      "- Global ##temp is forbidden. Tool blocks on suffix drift, missing creates, or mixed suffixes.",
    ].join("\n")
  },
  enforce(query: string) {
    const err = validateTempTableBatch(query)
    if (!err) return []
    // The validator helper already produces a per-variant message that
    // preserves the substrings tests pin to (malformed #temp suffix,
    // referenced without being created, inconsistent #temp suffixes).
    // The fixHint is the canonical refactor — one paragraph, always the
    // same shape, regardless of which sub-variant tripped.
    return [{
      code: "temp_table_integrity",
      severity: "block" as const,
      message: err,
      fixHint: DOCTRINE_FIX_HINTS.temp_table_integrity,
    }]
  },
}

// Doctrine: local #temp table naming integrity.
//
// Authoritative rule body lives here. Validator delegates structural
// enforcement to validateTempTableBatch(); this module wraps it so the
// rule is citable from one place and the prompt summary stays in sync
// with what the validator actually blocks.

import { validateTempTableBatch } from "../tools/mssql/validation.js"
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
    return [{ code: "temp_table_integrity", severity: "block" as const, message: err }]
  },
}

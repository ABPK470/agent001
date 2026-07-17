// Doctrine: bracketed table-alias convention for T-SQL.
//
// Every table alias is declared and referenced with [brackets] so reserved
// words (`off`, `on`, `as`, …) never break parsing. The validator
// auto-normalizes before execution; unfixable SQL is blocked.

import {
  detectAliasBracketViolations,
  normalizeMssqlAliasBrackets,
  validateAliasBracketConvention
} from "../../tools/database/mssql/sql-alias-brackets.js"
import { DOCTRINE_FIX_HINTS } from "./fix-hints.js"
import type { DoctrineModule } from "./types.js"

export const aliasBracketingDoctrine: DoctrineModule = {
  id: "mssql.alias-bracketing",
  version: "1.0.0",
  summaryBudgetBytes: 130,
  summary(): string {
    return "Alias brackets (enforced): WITH [cte] AS; FROM/JOIN AS [a] or FROM [cte]; [a].[Col] everywhere. Tool auto-fixes."
  },
  enforce(query: string) {
    const normalized = normalizeMssqlAliasBrackets(query)
    const err = validateAliasBracketConvention(normalized.query)
    if (!err) return []
    return [
      {
        code: "alias_bracket_convention",
        severity: "block" as const,
        message: err,
        fixHint: DOCTRINE_FIX_HINTS.alias_bracket_convention
      }
    ]
  }
}

export { detectAliasBracketViolations, normalizeMssqlAliasBrackets }

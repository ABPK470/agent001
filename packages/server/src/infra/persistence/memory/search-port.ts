import type { MemorySearchPort } from "../../../ports/memory-search.js"
import { createMssqlDegradedMemorySearch } from "../adapters/mssql/memory/degraded-search.js"
import { createSqliteMemorySearch } from "../adapters/sqlite/memory/fts-search.js"
import { getPlatformDbKind } from "../schema/kysely.js"

let cachedPort: MemorySearchPort | null = null

/** Return the keyword-search implementation matching the bound platform store. */
export function getMemorySearchPort(): MemorySearchPort {
  const kind = getPlatformDbKind()
  if (cachedPort?.kind === (kind === "sqlite" ? "sqlite-fts5" : "mssql-degraded")) return cachedPort
  cachedPort = kind === "sqlite" ? createSqliteMemorySearch() : createMssqlDegradedMemorySearch()
  return cachedPort
}

/** Test hook for rebinding the platform Kysely handle. */
export function resetMemorySearchPortForTests(): void {
  cachedPort = null
}

import type { MemorySearchPort } from "../../../ports/memory-search.js"
import { createMssqlDegradedMemorySearch } from "../adapters/mssql/memory/degraded-search.js"
import { createPostgresTsvectorMemorySearch } from "../adapters/postgres/memory/tsvector-search.js"
import { createSqliteMemorySearch } from "../adapters/sqlite/memory/fts-search.js"
import { getPlatformDbKind } from "../schema/kysely.js"

let cachedPort: MemorySearchPort | null = null

function portKindForDb(): MemorySearchPort["kind"] {
  const kind = getPlatformDbKind()
  if (kind === "sqlite") return "sqlite-fts5"
  if (kind === "postgres") return "postgres-tsvector"
  return "mssql-degraded"
}

function createPort(): MemorySearchPort {
  const kind = getPlatformDbKind()
  if (kind === "sqlite") return createSqliteMemorySearch()
  if (kind === "postgres") return createPostgresTsvectorMemorySearch()
  return createMssqlDegradedMemorySearch()
}

/** Return the keyword-search implementation matching the bound platform store. */
export function getMemorySearchPort(): MemorySearchPort {
  const want = portKindForDb()
  if (cachedPort?.kind === want) return cachedPort
  cachedPort = createPort()
  return cachedPort
}

/** Test hook for rebinding the platform Kysely handle. */
export function resetMemorySearchPortForTests(): void {
  cachedPort = null
}

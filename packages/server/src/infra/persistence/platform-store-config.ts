/**
 * Platform store selection — config only.
 * MIA_PLATFORM_STORE=sqlite|mssql|postgres (default **sqlite**, including
 * hosted until a deploy explicitly chooses mssql or postgres — see doctrine §5c).
 * Connection for mssql: MIA_PLATFORM_MSSQL_* (never warehouse connector pools).
 * Connection for postgres: MIA_PLATFORM_PG_* / MIA_PLATFORM_PG_URL.
 */

import type { PlatformStoreKind } from "../../ports/platform-store.js"

export function resolvePlatformStoreKind(
  env: NodeJS.ProcessEnv = process.env,
): PlatformStoreKind {
  const raw = (env["MIA_PLATFORM_STORE"] ?? "sqlite").trim().toLowerCase()
  if (raw === "sqlite" || raw === "mssql" || raw === "postgres") return raw
  throw new Error(
    `MIA_PLATFORM_STORE must be sqlite|mssql|postgres (got ${JSON.stringify(raw)})`,
  )
}

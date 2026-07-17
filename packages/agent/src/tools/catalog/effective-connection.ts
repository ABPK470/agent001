/**
 * Resolve which MSSQL connection catalog/tools should use for a run.
 *
 * Delegates to canonical connection resolution, then applies goal-based overrides
 * when the user names an environment in prose.
 */

import type { MssqlCatalogHost } from "../../runtime/runtime.js"
import { getCatalogConnectionNames } from "./store.js"
import {
  listMssqlConnectionNames,
  lookupRegistryKey,
  resolveMssqlConnectionName,
  tryResolveMssqlConnectionName
} from "../database/mssql/resolve-connection.js"

const GOAL_ENV_RE = /\b(dev|uat|prod|production|development)\b/i

export function resolveEffectiveMssqlConnection(
  host: MssqlCatalogHost,
  goal: string,
  explicitConnection?: string | null
): string {
  if (explicitConnection?.trim()) {
    return resolveMssqlConnectionName(host, explicitConnection)
  }

  const names = listMssqlConnectionNames(host).length > 0
    ? listMssqlConnectionNames(host)
    : getCatalogConnectionNames(host)

  const goalLc = goal.toLowerCase()
  for (const name of names) {
    if (goalLc.includes(name.toLowerCase())) return name
  }

  const envMatch = GOAL_ENV_RE.exec(goal)
  if (envMatch) {
    const token = envMatch[1]!.toLowerCase()
    const alias = token === "production" ? "prod" : token === "development" ? "dev" : token
    const hit = lookupRegistryKey(names, alias)
    if (hit) return hit
    const resolved = tryResolveMssqlConnectionName(host, alias)
    if (resolved) return resolved
  }

  return resolveMssqlConnectionName(host, null)
}

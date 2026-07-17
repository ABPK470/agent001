import { homedir, platform } from "node:os"
import { join } from "node:path"

import { isDatabricksConfigured } from "../../infra/llm/databricks-broker.js"
import { isLlmProvider } from "../../internal/enums/llm.js"
import { countEnabledMssqlConnectors } from "../../api/connectors/state/live-connectors.js"

import { parseEnvFile } from "./env-file.js"
import type { SetupLayout } from "./types.js"

/** Merged view of `.env` on disk + `process.env` (after dotenv). */
export interface EnvState {
  readonly envPath: string
  get(key: string): string | undefined
  has(key: string): boolean
}

export function readEnvState(envPath: string): EnvState {
  const file = parseEnvFile(envPath)
  const get = (key: string): string | undefined => {
    const fromProcess = process.env[key]?.trim()
    if (fromProcess) return fromProcess
    return file.get(key)?.trim() || undefined
  }
  return {
    envPath,
    get,
    has(key: string): boolean {
      return Boolean(get(key))
    },
  }
}

export function suggestDataDir(layout: SetupLayout): string {
  if (platform() === "win32") return "D:/mia/data"
  if (layout.packaged || layout.isProduction) return "/var/lib/mia"
  return join(homedir(), ".mia")
}

/**
 * MSSQL is "configured" when either:
 *   - the connectors DB (the source of truth) has an enabled `mssql` connector, or
 *   - the legacy `.env` vars (MSSQL_HOST / MSSQL_SERVER / MSSQL_DATABASES) are set
 *     (one-time seed bridge for existing deployments).
 */
export function hasMssqlConfigured(env: EnvState): boolean {
  if (countEnabledMssqlConnectors() > 0) return true
  return Boolean(env.get("MSSQL_HOST") || env.get("MSSQL_SERVER") || env.get("MSSQL_DATABASES"))
}

export function databricksAuthMode(env: EnvState): "m2m" | "pat" | null {
  if (env.get("DATABRICKS_CLIENT_ID") && env.get("DATABRICKS_CLIENT_SECRET")) return "m2m"
  if (env.get("DATABRICKS_TOKEN")) return "pat"
  return null
}

export function isLlmEnvValid(env: EnvState): boolean {
  const provider = env.get("LLM_PROVIDER")
  if (!provider) return false
  if (!isLlmProvider(provider)) return false
  if (provider === "databricks") return isDatabricksConfigured()
  return true
}

export function promptDefaultForKey(key: string, value: string | undefined): string | undefined {
  if (!value) return undefined
  if (/SECRET|PASSWORD|TOKEN|KEY/i.test(key)) return "(already set — Enter to keep)"
  return value
}

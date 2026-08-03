/**
 * MSSQL platform-store connection config (plan milestone 4).
 *
 * Separate from warehouse / Bridge connector pools — never reuse Sync
 * connector ids here. Env-only until composition grows richer secrets wiring.
 * Driver wiring is Kysely MssqlDialect (tedious/tarn), not npm `mssql` pools.
 */

export type MssqlPlatformConfig = {
  readonly server: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly password: string
  readonly encrypt: boolean
  readonly trustServerCertificate: boolean
}

function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback
  const v = raw.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "yes") return true
  if (v === "0" || v === "false" || v === "no") return false
  return fallback
}

/**
 * Resolve hosted MSSQL platform connection from env.
 * Throws when required fields are missing (fail loud at open time).
 */
export function resolveMssqlPlatformConfig(
  env: NodeJS.ProcessEnv = process.env,
): MssqlPlatformConfig {
  const server = (env["MIA_PLATFORM_MSSQL_SERVER"] ?? "").trim()
  const database = (env["MIA_PLATFORM_MSSQL_DATABASE"] ?? "").trim()
  const user = (env["MIA_PLATFORM_MSSQL_USER"] ?? "").trim()
  const password = env["MIA_PLATFORM_MSSQL_PASSWORD"] ?? ""
  if (!server || !database || !user) {
    throw new Error(
      "MSSQL platform store requires MIA_PLATFORM_MSSQL_SERVER, " +
        "MIA_PLATFORM_MSSQL_DATABASE, and MIA_PLATFORM_MSSQL_USER " +
        "(optional: PORT, PASSWORD, ENCRYPT, TRUST_SERVER_CERTIFICATE).",
    )
  }
  const portRaw = (env["MIA_PLATFORM_MSSQL_PORT"] ?? "1433").trim()
  const port = Number(portRaw)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`MIA_PLATFORM_MSSQL_PORT must be a positive number (got ${JSON.stringify(portRaw)})`)
  }
  return {
    server,
    port,
    database,
    user,
    password,
    encrypt: envBool(env["MIA_PLATFORM_MSSQL_ENCRYPT"], true),
    trustServerCertificate: envBool(env["MIA_PLATFORM_MSSQL_TRUST_SERVER_CERTIFICATE"], true),
  }
}

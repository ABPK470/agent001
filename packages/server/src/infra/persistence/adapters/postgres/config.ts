/**
 * Postgres platform-store connection config.
 * Separate from warehouse Sync / Bridge pools — never reuse connector ids.
 */

export type PostgresPlatformConfig = {
  readonly connectionString: string | null
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly password: string
  readonly ssl: boolean
}

function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback
  const v = raw.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "yes") return true
  if (v === "0" || v === "false" || v === "no") return false
  return fallback
}

/**
 * Resolve platform Postgres connection from env.
 * Prefer `MIA_PLATFORM_PG_URL`; otherwise host/database/user fields.
 */
export function resolvePostgresPlatformConfig(
  env: NodeJS.ProcessEnv = process.env,
): PostgresPlatformConfig {
  const connectionString = (env["MIA_PLATFORM_PG_URL"] ?? "").trim() || null
  if (connectionString) {
    return {
      connectionString,
      host: "",
      port: 5432,
      database: "",
      user: "",
      password: "",
      ssl: envBool(env["MIA_PLATFORM_PG_SSL"], false),
    }
  }
  const host = (env["MIA_PLATFORM_PG_HOST"] ?? "").trim()
  const database = (env["MIA_PLATFORM_PG_DATABASE"] ?? "").trim()
  const user = (env["MIA_PLATFORM_PG_USER"] ?? "").trim()
  const password = env["MIA_PLATFORM_PG_PASSWORD"] ?? ""
  if (!host || !database || !user) {
    throw new Error(
      "Postgres platform store requires MIA_PLATFORM_PG_URL or " +
        "MIA_PLATFORM_PG_HOST, MIA_PLATFORM_PG_DATABASE, and MIA_PLATFORM_PG_USER " +
        "(optional: PORT, PASSWORD, SSL).",
    )
  }
  const portRaw = (env["MIA_PLATFORM_PG_PORT"] ?? "5432").trim()
  const port = Number(portRaw)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`MIA_PLATFORM_PG_PORT must be a positive number (got ${JSON.stringify(portRaw)})`)
  }
  return {
    connectionString: null,
    host,
    port,
    database,
    user,
    password,
    ssl: envBool(env["MIA_PLATFORM_PG_SSL"], false),
  }
}

import type { ConfigureMssqlConnection } from "@mia/agent"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// ── MSSQL setup helper ────────────────────────────────────────────

function readKnowledgeFile(projectRoot: string, filePath: string): string | null {
  const resolved = resolve(projectRoot, filePath)
  try {
    if (!existsSync(resolved)) {
      console.warn(`MSSQL knowledge file not found: ${resolved}`)
      return null
    }
    const content = readFileSync(resolved, "utf-8").trim()
    if (!content) return null
    console.log(`MSSQL knowledge loaded: ${resolved} (${content.length} chars)`)
    return content
  } catch (e) {
    console.warn(`Failed to read MSSQL knowledge file: ${resolved}`, e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Load MSSQL connections from environment variables.
 * Supports multi-database mode (MSSQL_DATABASES JSON array) and
 * single-database mode (MSSQL_HOST).
 *
 * Returns the parsed boot configuration plus a human-readable summary.
 */
export function setupMssql(projectRoot: string): {
  configs: ConfigureMssqlConnection[]
  defaultConnectionName: string | null
  summary: string
} {
  const mssqlDatabasesJson = process.env["MSSQL_DATABASES"]
  if (mssqlDatabasesJson) {
    // ── Multi-database mode ──────────────────────────────────────
    let dbConfigs: Array<{
      name: string
      host: string
      port?: number
      user?: string
      password?: string
      domain?: string
      database?: string
      encrypt?: boolean
      trustServerCertificate?: boolean
      writeEnabled?: boolean
      knowledgePath?: string
    }>
    try {
      dbConfigs = JSON.parse(mssqlDatabasesJson)
      if (!Array.isArray(dbConfigs)) throw new Error("MSSQL_DATABASES must be a JSON array")
    } catch (e) {
      console.error("Invalid MSSQL_DATABASES JSON:", e instanceof Error ? e.message : e)
      process.exit(1)
    }

    const configs: ConfigureMssqlConnection[] = dbConfigs.map((db) => ({
      name: db.name,
      server: db.host,
      port: db.port ?? 1433,
      ...(db.domain ? { domain: db.domain } : {}),
      user: db.user ?? "sa",
      password: db.password ?? "",
      database: db.database ?? "master",
      options: {
        encrypt: db.encrypt !== false,
        trustServerCertificate: db.trustServerCertificate !== false
      },
      writeEnabled: db.writeEnabled ?? false,
      knowledge: db.knowledgePath ? readKnowledgeFile(projectRoot, db.knowledgePath) : null
    }))

    // Optional: pin which named connection is the agent's "home" default.
    // Without this the agent falls back to the first entry in the array.
    const defaultConn = process.env["MSSQL_DEFAULT_CONNECTION"]
    if (defaultConn) {
      console.log(`MSSQL default connection: ${defaultConn}`)
    }

    const summary = dbConfigs.map((db) => `${db.name}(${db.host}/${db.database ?? "master"})`).join(", ")
    console.log(`MSSQL databases: ${summary}`)
    return { configs, defaultConnectionName: defaultConn ?? null, summary }
  }

  // ── Single-database mode ─────────────────────────────────────
  const mssqlServer = process.env["MSSQL_HOST"] || process.env["MSSQL_SERVER"]
  if (mssqlServer) {
    const domain = process.env["MSSQL_DOMAIN"]
    const knowledgePath = process.env["MSSQL_KNOWLEDGE_FILE"]
    const configs: ConfigureMssqlConnection[] = [
      {
        name: "default",
        server: mssqlServer,
        port: Number(process.env["MSSQL_PORT"] ?? 1433),
        ...(domain ? { domain } : {}),
        user: process.env["MSSQL_USER"] ?? "sa",
        password: process.env["MSSQL_PASSWORD"] ?? "",
        database: process.env["MSSQL_DATABASE"] ?? "master",
        options: {
          encrypt: process.env["MSSQL_ENCRYPT"] !== "false",
          trustServerCertificate: process.env["MSSQL_TRUST_CERT"] !== "false"
        },
        writeEnabled: process.env["MSSQL_WRITE_ENABLED"] === "true",
        knowledge: knowledgePath ? readKnowledgeFile(projectRoot, knowledgePath) : null
      }
    ]
    if (process.env["MSSQL_WRITE_ENABLED"] === "true") {
      const summary = `${mssqlServer} (WRITE mode enabled)`
      console.log(`MSSQL: ${summary}`)
      return { configs, defaultConnectionName: null, summary }
    }
    const summary = `${mssqlServer} (read-only)`
    console.log(`MSSQL: ${summary}`)
    return { configs, defaultConnectionName: null, summary }
  }

  return { configs: [], defaultConnectionName: null, summary: "not configured" }
}

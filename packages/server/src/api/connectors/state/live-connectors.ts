/**
 * Connector seed + reload — mirrors `sync/state/live-environments.ts`.
 *
 * Loading priority (only consulted when the `connectors` table is empty):
 *   1. `deploy/connectors/connectors.json` if present — explicit operator
 *      seed (the source of truth, exportable/importable like the
 *      sync-environments seed file).
 *   2. Else synthesise one `mssql` connector per MSSQL connection registered
 *      at boot from `.env` — the one-time migration bridge so existing
 *      deployments populate the DB without hand-writing the seed file. After
 *      this first boot the `.env` vars are no longer read.
 *
 * Phase 2 wiring: `host.mssql.databases` is built from the persisted
 * `mssql`-kind connectors via `mssqlConfigsFromConnectors` (see
 * `mssql-from-connectors.ts`). Sync still resolves environments by name
 * against `host.mssql.databases`; connector `name` is preserved verbatim as
 * the registry key, so flipping the source does not change resolution.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import Database from "better-sqlite3"
import type { ConfigureMssqlConnection } from "@mia/agent"
import {
  toConnectorId,
  withConnectorConfigDefaults,
  type Connector,
  type ConnectorKindId,
} from "@mia/shared-types"

import * as db from "../../../infra/persistence/sqlite.js"
import { getDbPath } from "../../../infra/persistence/connection.js"

const DEFAULT_SEED_PATH = "deploy/connectors/connectors.json"

export interface PersistedConnectorLoad {
  connectors: Connector[]
  source: "db" | "file" | "mssql" | "none"
  seeded: boolean
  summary: string
}

interface ConnectorSeedFile {
  version: 1
  connectors: Array<{
    id: string
    kind: ConnectorKindId
    name: string
    displayName?: string
    config?: Record<string, string | number | boolean | null>
    enabled?: boolean
  }>
}

function serialiseConnector(
  connector: Connector,
  actor: string | null,
  createdAt?: string,
): db.DbConnector {
  const now = new Date().toISOString()
  return {
    id: connector.id,
    kind: connector.kind,
    body_json: JSON.stringify(connector),
    enabled: connector.enabled ? 1 : 0,
    created_at: createdAt ?? now,
    updated_at: now,
    updated_by: actor,
  }
}

function parseRow(row: db.DbConnector): Connector {
  const body = JSON.parse(row.body_json) as Connector
  return {
    ...body,
    id: row.id,
    kind: row.kind as ConnectorKindId,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

function renderSummary(connectors: Connector[]): string {
  return connectors.map((c) => `${c.id}[${c.kind}]`).join(", ")
}

function mssqlConfigFromConnection(
  conn: ConfigureMssqlConnection,
): Record<string, string | number | boolean | null> {
  return {
    host: conn.server ?? null,
    port: conn.port ?? null,
    database: conn.database ?? null,
    user: conn.user ?? null,
    password: conn.password ?? "",
    domain: conn.domain ?? null,
    encrypt: conn.options?.encrypt ?? true,
    trustServerCertificate: conn.options?.trustServerCertificate ?? true,
    knowledgePath: conn.knowledgePath ?? null,
  }
}

function synthesiseFromMssql(connections: readonly ConfigureMssqlConnection[]): Connector[] {
  const now = new Date().toISOString()
  return connections.map((conn) => {
    const id = toConnectorId(conn.name) || "default"
    return {
      id,
      kind: "mssql" as ConnectorKindId,
      name: conn.name,
      displayName: conn.name,
      config: withConnectorConfigDefaults("mssql", mssqlConfigFromConnection(conn)),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
    }
  })
}

function loadFromSeedFile(projectRoot: string, relPath: string): Connector[] {
  const configPath = resolve(projectRoot, relPath)
  if (!existsSync(configPath)) return []
  const raw = readFileSync(configPath, "utf-8")
  const parsed = JSON.parse(raw) as ConnectorSeedFile
  if (parsed.version !== 1) throw new Error(`Unsupported connectors seed version: ${parsed.version}`)
  const now = new Date().toISOString()
  return parsed.connectors.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    displayName: entry.displayName ?? entry.name,
    config: withConnectorConfigDefaults(entry.kind, entry.config ?? {}),
    enabled: entry.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    updatedBy: null,
  }))
}

export function loadPersistedConnectors(
  projectRoot: string,
  connections: readonly ConfigureMssqlConnection[],
  relPath = DEFAULT_SEED_PATH,
): PersistedConnectorLoad {
  const persistedRows = db.listConnectors()
  if (persistedRows.length > 0) {
    const connectors = persistedRows.map(parseRow)
    return { connectors, source: "db", seeded: false, summary: renderSummary(connectors) }
  }

  const fromFile = loadFromSeedFile(projectRoot, relPath)
  const connectors = fromFile.length > 0 ? fromFile : synthesiseFromMssql(connections)
  for (const connector of connectors) {
    db.saveConnector(serialiseConnector(connector, null))
  }
  const source = fromFile.length > 0 ? "file" : connectors.length > 0 ? "mssql" : "none"
  return { connectors, source, seeded: true, summary: renderSummary(connectors) }
}

/**
 * Backfill missing `connectorId` on sync environments by matching env name
 * to an mssql connector id/name. Call **after** both connectors and
 * environments have been loaded/seeded (first boot otherwise finds no env rows).
 */
export function linkSyncEnvironmentConnectorIds(): void {
  const envRows = db.listSyncEnvironments()
  if (envRows.length === 0) return

  const connectorRows = db.listConnectors().filter((row) => row.kind === "mssql")
  const connectorByKey = new Map<string, string>()
  for (const row of connectorRows) {
    connectorByKey.set(row.id.toLowerCase(), row.id)
    try {
      const body = JSON.parse(row.body_json) as { name?: string }
      if (typeof body.name === "string" && body.name.trim() !== "") {
        connectorByKey.set(body.name.toLowerCase(), row.id)
      }
    } catch {
      /* ignore malformed body */
    }
  }

  const now = new Date().toISOString()
  for (const env of envRows) {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(env.body_json) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof body["connectorId"] === "string" && body["connectorId"].trim() !== "") continue

    const matchId = connectorByKey.get(env.name.toLowerCase())
    if (!matchId) continue

    body["connectorId"] = matchId
    db.saveSyncEnvironment({
      ...env,
      body_json: JSON.stringify(body),
      updated_at: now,
    })
  }
}

/**
 * Count enabled `mssql` connectors without booting the persistence layer.
 *
 * Opens the SQLite file read-only (no migrations, no seeding) so pre-boot CLI
 * tools — the setup wizard/checks — can ask "is MSSQL configured?" against the
 * new source of truth without side effects. Returns 0 when the file or table
 * is absent (e.g. before first boot).
 */
export function countEnabledMssqlConnectors(): number {
  const path = getDbPath()
  if (!existsSync(path)) return 0
  try {
    const conn = new Database(path, { readonly: true })
    try {
      const row = conn
        .prepare("SELECT COUNT(*) AS count FROM connectors WHERE kind = 'mssql' AND enabled = 1")
        .get() as { count: number } | undefined
      return row?.count ?? 0
    } finally {
      conn.close()
    }
  } catch {
    return 0
  }
}

/**
 * Connectors → MSSQL boot configs (Phase 2 source of truth).
 *
 * `host.mssql.databases` is no longer built from `.env`; it is built from the
 * persisted `mssql`-kind connectors. This helper maps each enabled mssql
 * connector back to the `ConfigureMssqlConnection` shape the agent host
 * expects, reading the optional knowledge file from the connector's
 * `knowledgePath`.
 *
 * Connection *names* are preserved verbatim (the connector `name` is the
 * registry key sync environments resolve against), so flipping the source
 * does not change sync resolution.
 */

import type { ConfigureMssqlConnection } from "@mia/agent"
import type { Connector } from "@mia/shared-types"

import { readKnowledgeFile } from "../../../infra/mssql/setup.js"

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/**
 * Build the live MSSQL boot configs from persisted connectors. Disabled
 * connectors and non-mssql kinds are skipped. Order is preserved so the
 * first enabled mssql connector remains the implicit default.
 */
export function mssqlConfigsFromConnectors(
  connectors: readonly Connector[],
  projectRoot: string,
): ConfigureMssqlConnection[] {
  const configs: ConfigureMssqlConnection[] = []
  for (const connector of connectors) {
    if (connector.kind !== "mssql" || !connector.enabled) continue
    const c = connector.config
    const host = asString(c["host"])
    if (!host) continue
    const knowledgePath = asString(c["knowledgePath"])
    configs.push({
      name: connector.name,
      server: host,
      port: asNumber(c["port"]) ?? 1433,
      database: asString(c["database"]) ?? "master",
      user: asString(c["user"]) ?? "sa",
      password: asString(c["password"]) ?? "",
      ...(asString(c["domain"]) ? { domain: asString(c["domain"])! } : {}),
      options: {
        encrypt: asBoolean(c["encrypt"], true),
        trustServerCertificate: asBoolean(c["trustServerCertificate"], true),
      },
      knowledgePath: knowledgePath,
      knowledge: knowledgePath ? readKnowledgeFile(projectRoot, knowledgePath) : null,
    })
  }
  return configs
}

import { parseBoundaryJson } from "../../../internal/parse-json.js"

/**
 * runtime/movement-port.ts — build the opaque `host.connectors` port at boot.
 *
 * Wires persisted connectors to per-kind adapter factories:
 *   - mssql resolves a live pool by connector id via host.mssql.pools (MssqlPoolProvider).
 *   - postgres creates a per-move pg.Pool from the connector config.
 *   - oracle creates a per-move oracledb pool from the connector config.
 *
 * The returned port is injected into configureAgent({ connectors }) and is the
 * sole runtime surface the agent + UI call for Bridge.
 */

import { type AgentHost } from "@mia/agent"
import {
  AdapterRegistry,
  buildConnectorPort,
  createAqueductAdapter,
  createDatabricksAdapter,
  createDenodoAdapter,
  createHttpApiAdapter,
  createMssqlAdapter,
  createObjectFileAdapter,
  createOracleAdapter,
  createPostgresAdapter,
  createWebhdfsAdapter,
  createOraclePool,
  defaultAqueductDriver,
  defaultAwsDriver,
  defaultAzureDriver,
  defaultDatabricksDriver,
  defaultDenodoDriver,
  defaultFtpDriver,
  defaultHttpDriver,
  defaultMssqlDriver,
  defaultOracleDriver,
  defaultPostgresDriver,
  defaultWebhdfsDriver,
  type ConnectorPort} from "@mia/connectors"
import { Pool } from "pg"
import type { Connector, ConnectorKindId } from "@mia/shared-types"
import * as db from "../../../infra/persistence/sqlite.js"

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/** Parse a persisted row's body_json back into a Connector. */
function parseConnector(row: db.DbConnector): Connector {
  const body = parseBoundaryJson(row.body_json) as Connector
  return {
    ...body,
    id: row.id,
    kind: row.kind as ConnectorKindId,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by}
}

/**
 * Re-read the persisted connectors from the DB. Called live on every port
 * call so runtime create/enable/disable/delete is reflected without a
 * server restart.
 */
function listConnectorsLive(): readonly Connector[] {
  return db.listConnectors().map(parseConnector)
}

/** Build a pg.Pool config from a persisted postgres connector's config. */
function pgPoolConfig(connector: Connector): ConstructorParameters<typeof Pool>[0] {
  const c = connector.config
  return {
    host: asString(c["host"]),
    port: asNumber(c["port"]),
    database: asString(c["database"]),
    user: asString(c["user"]),
    password: asString(c["password"]),
    ssl: asBoolean(c["ssl"], false) ? ({ rejectUnauthorized: false } as object) : false,
  }
}

export function buildMovementPort(host: AgentHost): ConnectorPort {
  const registry = new AdapterRegistry()

  registry.register("mssql", (connector) => {
    return createMssqlAdapter(connector, {
      driverProvider: async () => {
        const pools = host.mssql.pools
        if (!pools) throw new Error("MSSQL pool provider not configured for Bridge.")
        const { pool } = await pools.get(connector.id)
        return defaultMssqlDriver(pool)
      }
    })
  })

  registry.register("postgres", (connector) => {
    return createPostgresAdapter(connector, {
      driverProvider: () => {
        const pool = new Pool(pgPoolConfig(connector))
        return Promise.resolve(defaultPostgresDriver(pool))
      }
    })
  })

  registry.register("oracle", (connector) => {
    return createOracleAdapter(connector, {
      driverProvider: async () => {
        const pool = await createOraclePool(connector)
        return defaultOracleDriver(pool)
      }
    })
  })

  registry.register("httpApi", (connector) => {
    return createHttpApiAdapter(connector, {
      driverProvider: () => Promise.resolve(defaultHttpDriver(connector)),
    })
  })

  registry.register("denodo", (connector) => {
    return createDenodoAdapter(connector, {
      driverProvider: () => Promise.resolve(defaultDenodoDriver(connector)),
    })
  })

  registry.register("webhdfs", (connector) => {
    return createWebhdfsAdapter(connector, {
      driverProvider: () => Promise.resolve(defaultWebhdfsDriver(connector))
    })
  })

  registry.register("aws", (connector) => {
    return createObjectFileAdapter("aws", connector, {
      driverProvider: () => Promise.resolve(defaultAwsDriver(connector))
    })
  })

  registry.register("azure", (connector) => {
    return createObjectFileAdapter("azure", connector, {
      driverProvider: () => Promise.resolve(defaultAzureDriver(connector))
    })
  })

  registry.register("ftp", (connector) => {
    return createObjectFileAdapter("ftp", connector, {
      driverProvider: () => Promise.resolve(defaultFtpDriver(connector))
    })
  })

  registry.register("databricks", (connector) => {
    return createDatabricksAdapter(connector, {
      driverProvider: () => Promise.resolve(defaultDatabricksDriver(connector))
    })
  })

  registry.register("aqueduct", (connector) => {
    return createAqueductAdapter(connector, {
      driverProvider: () => Promise.resolve(defaultAqueductDriver(connector)),
    })
  })

  // hive: adapter + port ship in @mia/connectors, but the HiveServer2 thrift
  // client binding is not wired here yet. The kind stays greyed-out in the UI
  // (enabled=false) until a HiveClient provider is supplied; register it only
  // then to avoid advertising a connector kind that can't move data.

  return buildConnectorPort(registry, listConnectorsLive)
}

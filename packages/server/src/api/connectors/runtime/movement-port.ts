/**
 * runtime/movement-port.ts — build the opaque `host.connectors` port at boot.
 *
 * Wires persisted connectors to per-kind adapter factories:
 *   - mssql resolves a live pool by connector id via host.mssql.pools (MssqlPoolProvider).
 *   - postgres creates a per-move pg.Pool from the connector config.
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
  createPostgresAdapter,
  createWebhdfsAdapter,
  defaultAqueductDriver,
  defaultAwsDriver,
  defaultAzureDriver,
  defaultDatabricksDriver,
  defaultDenodoDriver,
  defaultFtpDriver,
  defaultHttpDriver,
  defaultMssqlDriver,
  defaultPostgresDriver,
  defaultWebhdfsDriver,
  type ConnectorPort,
} from "@mia/connectors"
import { Pool } from "pg"
import type { Connector, ConnectorKindId } from "@mia/shared-types"
import * as db from "../../../platform/persistence/sqlite.js"

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
    const writeEnabled = asBoolean(connector.config["writeEnabled"], false)
    return createMssqlAdapter(connector, {
      driverProvider: async () => {
        const pools = host.mssql.pools
        if (!pools) throw new Error("MSSQL pool provider not configured for Bridge.")
        const { pool } = await pools.get(connector.id)
        return defaultMssqlDriver(pool)
      },
      writeEnabled,
    })
  })

  registry.register("postgres", (connector) => {
    const writeEnabled = asBoolean(connector.config["writeEnabled"], false)
    return createPostgresAdapter(connector, {
      driverProvider: () => {
        const pool = new Pool(pgPoolConfig(connector))
        return Promise.resolve(defaultPostgresDriver(pool))
      },
      writeEnabled,
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
    const writeEnabled = asBoolean(connector.config["writeEnabled"], false)
    return createWebhdfsAdapter(connector, {
      driverProvider: () => Promise.resolve(defaultWebhdfsDriver(connector)),
      writeEnabled,
    })
  })

  registry.register("aws", (connector) => {
    const writeEnabled = asBoolean(connector.config["writeEnabled"], false)
    return createObjectFileAdapter("aws", connector, {
      driverProvider: () => Promise.resolve(defaultAwsDriver(connector)),
      writeEnabled,
    })
  })

  registry.register("azure", (connector) => {
    const writeEnabled = asBoolean(connector.config["writeEnabled"], false)
    return createObjectFileAdapter("azure", connector, {
      driverProvider: () => Promise.resolve(defaultAzureDriver(connector)),
      writeEnabled,
    })
  })

  registry.register("ftp", (connector) => {
    const writeEnabled = asBoolean(connector.config["writeEnabled"], false)
    return createObjectFileAdapter("ftp", connector, {
      driverProvider: () => Promise.resolve(defaultFtpDriver(connector)),
      writeEnabled,
    })
  })

  registry.register("databricks", (connector) => {
    const writeEnabled = asBoolean(connector.config["writeEnabled"], false)
    return createDatabricksAdapter(connector, {
      driverProvider: () => Promise.resolve(defaultDatabricksDriver(connector)),
      writeEnabled,
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

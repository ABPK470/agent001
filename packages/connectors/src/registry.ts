/**
 * registry.ts — AdapterRegistry + the opaque host port builder.
 *
 * The registry maps a connector kind to an {@link AdapterFactory}. The port
 * resolves a connector id to its persisted {@link Connector}, asks the
 * registry for the adapter, and runs the streaming {@link moveData} engine.
 *
 * The port object is structurally compatible with `ConnectorsHost` in
 * @mia/agent (which only imports the shared types). @mia/connectors never
 * imports @mia/agent, so there is no dependency cycle.
 */

import type {
  AdapterCapabilities,
  AdapterFactory,
  Connector,
  ConnectorAdapter,
  ConnectorInfo,
  ConnectorKindId,
  MoveSummary,
  ReadSpec,
  Row,
  Transform,
  WriteSpec,
} from "@mia/shared-types"
import { applyTransform, moveData, type MoveOptions } from "./engine.js"
import { listTablesSql, tableNameFromRow } from "./list-tables.js"

export class AdapterRegistry {
  private readonly factories = new Map<ConnectorKindId, AdapterFactory>()

  register(kind: ConnectorKindId, factory: AdapterFactory): void {
    this.factories.set(kind, factory)
  }

  has(kind: ConnectorKindId): boolean {
    return this.factories.has(kind)
  }

  forConnector(connector: Connector): ConnectorAdapter {
    const factory = this.factories.get(connector.kind)
    if (!factory) {
      throw new Error(`no adapter registered for kind '${connector.kind}'`)
    }
    return factory(connector)
  }
}

export interface ConnectorPortMoveSource {
  readonly connectorId: string
  readonly spec: ReadSpec
}

export interface ConnectorPortMoveTarget {
  readonly connectorId: string
  readonly spec: WriteSpec
  readonly stopOnError?: boolean
}

export interface ConnectorPortMoveOptions {
  readonly transform?: Transform
  readonly signal?: AbortSignal
}

export interface ConnectorPort {
  moveData(
    source: ConnectorPortMoveSource,
    target: ConnectorPortMoveTarget,
    options?: ConnectorPortMoveOptions,
  ): Promise<MoveSummary>
  /** Read up to `limit` rows from the source, apply the transform, return them (no write). */
  previewMove(
    source: ConnectorPortMoveSource,
    options?: { transform?: Transform; limit?: number; signal?: AbortSignal },
  ): Promise<{ rows: Row[]; truncated: boolean }>
  /**
   * List schema-qualified base tables on a SQL connector (Bridge target picker).
   * Throws when the connector kind has no table catalog.
   */
  listTables(connectorId: string): Promise<string[]>
  listAdapters(): ConnectorInfo[]
}

/** Resolve a connector id to its persisted Connector, or throw. */
function resolveConnector(connectors: readonly Connector[], id: string): Connector {
  const connector = connectors.find((c) => c.id === id)
  if (!connector) throw new Error(`unknown connector id '${id}'`)
  return connector
}

/**
 * A connector source is either a static snapshot or a provider that re-reads
 * the persisted connectors live. The live form lets the port reflect
 * runtime create/enable/disable/delete without a server restart.
 */
export type ConnectorSource = readonly Connector[] | (() => readonly Connector[])

function readConnectors(source: ConnectorSource): readonly Connector[] {
  return typeof source === "function" ? source() : source
}

export function connectorInfo(connector: Connector, capabilities: AdapterCapabilities): ConnectorInfo {
  return {
    id: connector.id,
    kind: connector.kind,
    name: connector.name,
    displayName: connector.displayName,
    enabled: connector.enabled,
    capabilities,
  }
}

/**
 * Build the opaque host port from a registry + the persisted connectors.
 * The port resolves ids, builds adapters per move, and runs the engine.
 *
 * `connectors` may be a static snapshot or a live provider `() => Connector[]`
 * that re-reads the persistence layer on each call — the live form keeps the
 * port in sync with runtime create/enable/disable/delete without a restart.
 */
export function buildConnectorPort(
  registry: AdapterRegistry,
  connectors: ConnectorSource,
): ConnectorPort {
  return {
    async moveData(source, target, options) {
      const list = readConnectors(connectors)
      const srcConnector = resolveConnector(list, source.connectorId)
      const tgtConnector = resolveConnector(list, target.connectorId)
      const srcAdapter = registry.forConnector(srcConnector)
      const tgtAdapter = registry.forConnector(tgtConnector)
      const moveOptions: MoveOptions = {
        transform: options?.transform,
        signal: options?.signal,
      }
      return moveData(
        { adapter: srcAdapter, spec: source.spec },
        { adapter: tgtAdapter, spec: target.spec, stopOnError: target.stopOnError },
        moveOptions,
      )
    },
    async previewMove(source, options) {
      const limit = options?.limit ?? 50
      const list = readConnectors(connectors)
      const srcConnector = resolveConnector(list, source.connectorId)
      const srcAdapter = registry.forConnector(srcConnector)
      await srcAdapter.open()
      try {
        const rows: Row[] = []
        let truncated = false
        for await (const batch of applyTransform(
          srcAdapter.read(source.spec),
          options?.transform,
          options?.signal,
        )) {
          for (const row of batch) {
            if (rows.length >= limit) {
              truncated = true
              break
            }
            rows.push(row)
          }
          if (truncated) break
        }
        return { rows, truncated }
      } finally {
        await srcAdapter.close()
      }
    },
    async listTables(connectorId) {
      const list = readConnectors(connectors)
      const connector = resolveConnector(list, connectorId)
      const sql = listTablesSql(connector.kind)
      if (!sql) {
        throw new Error(`table listing is not supported for connector kind '${connector.kind}'`)
      }
      if (!registry.has(connector.kind)) {
        throw new Error(`no adapter registered for kind '${connector.kind}'`)
      }
      const adapter = registry.forConnector(connector)
      if (!adapter.capabilities.read && !adapter.capabilities.query) {
        throw new Error(`connector '${connectorId}' cannot list tables`)
      }
      await adapter.open()
      try {
        const names: string[] = []
        const seen = new Set<string>()
        for await (const batch of adapter.read({ kind: "sql", sql })) {
          for (const row of batch) {
            const name = tableNameFromRow(row)
            if (!name || seen.has(name)) continue
            seen.add(name)
            names.push(name)
          }
        }
        names.sort((a, b) => a.localeCompare(b))
        return names
      } finally {
        await adapter.close()
      }
    },
    listAdapters() {
      return readConnectors(connectors)
        .filter((c) => registry.has(c.kind))
        .map((c) => connectorInfo(c, registry.forConnector(c).capabilities))
    },
  }
}

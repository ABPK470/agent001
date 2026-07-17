/**
 * Per-connection pool slot gate.
 *
 * node-mssql pools queue when exhausted, but under burst load (parallel table
 * diffs × src/tgt queries) connections get recycled while still in use and
 * surface as "Connection is closed". We bound concurrent in-flight work per
 * named connection to stay inside a safe budget derived from pool.max.
 */

import type { MssqlAccessHost, SyncEnvironmentRegistryHost } from "../../ports/host.js"

interface GateState {
  limit: number
  active: number
  queue: Array<() => void>
}

type PoolGateHost = MssqlAccessHost & SyncEnvironmentRegistryHost

const gatesByHost = new WeakMap<MssqlAccessHost, Map<string, GateState>>()

export function readPoolMax(host: PoolGateHost, connection: string): number {
  const pools = host.mssql.pools
  if (pools) {
    const env = host.sync.environments.items.get(connection)
    const connectorId = env?.connectorId
    if (connectorId) {
      const max = pools.configOf(connectorId)?.pool?.max
      if (typeof max === "number" && max > 0) return max
    }
  }
  return 10
}

/** Slots available for sync work on this connection (pool max minus headroom). */
export function poolGateLimit(host: PoolGateHost, connection: string): number {
  const headroom = Math.max(1, parseInt(process.env["SYNC_POOL_HEADROOM"] ?? "3", 10) || 3)
  return Math.max(1, readPoolMax(host, connection) - headroom)
}

function gateFor(host: PoolGateHost, connection: string): GateState {
  let perHost = gatesByHost.get(host)
  if (!perHost) {
    perHost = new Map()
    gatesByHost.set(host, perHost)
  }
  let gate = perHost.get(connection)
  if (!gate) {
    gate = { limit: poolGateLimit(host, connection), active: 0, queue: [] }
    perHost.set(connection, gate)
  }
  return gate
}

function acquire(gate: GateState): Promise<void> {
  if (gate.active < gate.limit) {
    gate.active++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    gate.queue.push(() => {
      gate.active++
      resolve()
    })
  })
}

function release(gate: GateState): void {
  gate.active--
  const next = gate.queue.shift()
  if (next) next()
}

/** Run one pool-backed operation while holding a gate slot on `connection`. */
export async function withPoolSlot<T>(
  host: PoolGateHost,
  connection: string,
  fn: () => Promise<T>
): Promise<T> {
  const gate = gateFor(host, connection)
  await acquire(gate)
  try {
    return await fn()
  } finally {
    release(gate)
  }
}

/** Test-only — reset gate state for a host. */
export function _resetPoolGatesForHost(host: MssqlAccessHost): void {
  gatesByHost.delete(host)
}

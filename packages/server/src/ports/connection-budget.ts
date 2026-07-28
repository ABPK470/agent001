/**
 * Logical connection budgets for warehouse MSSQL pools.
 * One physical pool per connector; agent-query and sync-work take separate leases
 * so they cannot oversubscribe to "Connection is closed".
 */

export type ConnectionBudgetClass = "agent-query" | "sync-work"

export interface ConnectionBudgetPort {
  withSlot<T>(
    connectorKey: string,
    budgetClass: ConnectionBudgetClass,
    limit: number,
    fn: () => Promise<T>
  ): Promise<T>
  stats(): Record<string, { limit: number; active: number; waiting: number }>
}

interface GateState {
  limit: number
  active: number
  queue: Array<() => void>
}

function gateKey(connectorKey: string, budgetClass: ConnectionBudgetClass): string {
  return `${budgetClass}:${connectorKey}`
}

export class MemoryConnectionBudget implements ConnectionBudgetPort {
  private readonly gates = new Map<string, GateState>()

  withSlot<T>(
    connectorKey: string,
    budgetClass: ConnectionBudgetClass,
    limit: number,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = gateKey(connectorKey, budgetClass)
    let gate = this.gates.get(key)
    if (!gate) {
      gate = { limit: Math.max(1, limit), active: 0, queue: [] }
      this.gates.set(key, gate)
    } else {
      gate.limit = Math.max(1, limit)
    }
    return this.runWithGate(gate, fn)
  }

  private async runWithGate<T>(gate: GateState, fn: () => Promise<T>): Promise<T> {
    await this.acquire(gate)
    try {
      return await fn()
    } finally {
      this.release(gate)
    }
  }

  private acquire(gate: GateState): Promise<void> {
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

  private release(gate: GateState): void {
    gate.active--
    const next = gate.queue.shift()
    if (next) next()
  }

  stats(): Record<string, { limit: number; active: number; waiting: number }> {
    const out: Record<string, { limit: number; active: number; waiting: number }> = {}
    for (const [k, g] of this.gates) {
      out[k] = { limit: g.limit, active: g.active, waiting: g.queue.length }
    }
    return out
  }
}

const _default = new MemoryConnectionBudget()

export function getConnectionBudget(): ConnectionBudgetPort {
  return _default
}

/** Sync work: pool.max − headroom. */
export function syncBudgetLimit(poolMax: number): number {
  const headroom = Math.max(1, parseInt(process.env["SYNC_POOL_HEADROOM"] ?? "3", 10) || 3)
  return Math.max(1, poolMax - headroom)
}

/** Agent queries: headroom slots (reserved away from sync). */
export function agentBudgetLimit(poolMax: number): number {
  const headroom = Math.max(1, parseInt(process.env["SYNC_POOL_HEADROOM"] ?? "3", 10) || 3)
  const explicit = parseInt(process.env["AGENT_POOL_SLOTS"] ?? "", 10)
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, poolMax)
  return Math.max(1, Math.min(headroom, poolMax))
}

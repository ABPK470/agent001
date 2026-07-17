import { describe, expect, it } from "vitest"
import type { MssqlAccessHost, SyncEnvironmentRegistryHost } from "../../ports/host.js"
import {
  resolveEntityPreviewConcurrency,
  resolvePreviewTableConcurrency
} from "./pool-concurrency.js"
import { _resetPoolGatesForHost } from "./pool-gate.js"

function stubHost(poolMax: number): MssqlAccessHost & SyncEnvironmentRegistryHost {
  const config = { pool: { max: poolMax } }
  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: "dev" },
      pools: {
        async get() {
          throw new Error("not used")
        },
        async getByName() {
          throw new Error("not used")
        },
        configOf: (id: string) => (id === "dev" || id === "uat" ? config : undefined),
        list: () => [{ id: "dev", name: "dev" }, { id: "uat", name: "uat" }],
        invalidate() {}
      }
    },
    sync: {
      environments: {
        items: new Map([
          ["dev", { name: "dev", connectorId: "dev" }],
          ["uat", { name: "uat", connectorId: "uat" }]
        ])
      }
    }
  } as unknown as MssqlAccessHost & SyncEnvironmentRegistryHost
}

describe("pool concurrency", () => {
  it("derives table concurrency from pool max (20 → 8 tables with headroom 3)", () => {
    const host = stubHost(20)
    _resetPoolGatesForHost(host)
    expect(resolvePreviewTableConcurrency(host, "dev", "uat")).toBe(8)
  })

  it("keeps entity preview at 1 when table parallelism fills the budget", () => {
    const host = stubHost(20)
    _resetPoolGatesForHost(host)
    expect(resolveEntityPreviewConcurrency(host, "dev", "uat")).toBe(1)
  })

  it("reduces table concurrency on small pools (max 10 → 3 tables)", () => {
    const host = stubHost(10)
    _resetPoolGatesForHost(host)
    expect(resolvePreviewTableConcurrency(host, "dev", "uat")).toBe(3)
    expect(resolveEntityPreviewConcurrency(host, "dev", "uat")).toBe(1)
  })
})

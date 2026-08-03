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
        configOf: async (id: string) => (id === "dev" || id === "uat" ? config : undefined),
        list: async () => [{ id: "dev", name: "dev" }, { id: "uat", name: "uat" }],
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
  it("derives table concurrency from pool max (20 → 8 tables with headroom 3)", async () => {
    const host = stubHost(20)
    _resetPoolGatesForHost(host)
    expect(await resolvePreviewTableConcurrency(host, "dev", "uat")).toBe(8)
  })

  it("keeps entity preview at 1 when table parallelism fills the budget", async () => {
    const host = stubHost(20)
    _resetPoolGatesForHost(host)
    expect(await resolveEntityPreviewConcurrency(host, "dev", "uat")).toBe(1)
  })

  it("reduces table concurrency on small pools (max 10 → 3 tables)", async () => {
    const host = stubHost(10)
    _resetPoolGatesForHost(host)
    expect(await resolvePreviewTableConcurrency(host, "dev", "uat")).toBe(3)
    expect(await resolveEntityPreviewConcurrency(host, "dev", "uat")).toBe(1)
  })
})

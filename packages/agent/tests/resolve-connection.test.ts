import { describe, expect, it } from "vitest"
import type { AgentHost } from "../src/application/shell/runtime.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import { getCatalog } from "../src/tools/catalog/store.js"
import {
  canonicalizeConfiguredConnectionName,
  lookupRegistryKey,
  resolveMssqlConnectionName
} from "../src/tools/mssql/resolve-connection.js"

function host(names: string[], defaultConn: string | null = null): AgentHost {
  return {
    mssql: {
      databases: new Map(names.map((n) => [n, {} as never])),
      defaultConnection: { value: defaultConn }
    },
    catalog: { instances: new Map(), defaultCachePath: { value: undefined } }
  } as unknown as AgentHost
}

describe("resolveMssqlConnectionName", () => {
  it("treats dev, DEV, and Dev as the same connection", () => {
    const h = host(["DEV", "UAT"], "dev")
    expect(resolveMssqlConnectionName(h, "dev")).toBe("DEV")
    expect(resolveMssqlConnectionName(h, "DEV")).toBe("DEV")
    expect(resolveMssqlConnectionName(h, "Dev")).toBe("DEV")
    expect(resolveMssqlConnectionName(h, null)).toBe("DEV")
  })

  it("canonicalizes MSSQL_DEFAULT_CONNECTION at boot", () => {
    const keys = ["DEV", "UAT"]
    expect(canonicalizeConfiguredConnectionName(keys, "dev")).toBe("DEV")
    expect(canonicalizeConfiguredConnectionName(keys, "DEV")).toBe("DEV")
  })

  it("lookupRegistryKey is case-insensitive", () => {
    expect(lookupRegistryKey(["DEV", "UAT"], "dev")).toBe("DEV")
    expect(lookupRegistryKey(["dev"], "DEV")).toBe("dev")
  })

  it("getCatalog resolves lowercase connection to canonical catalog key", () => {
    const emptySnap = {
      version: 7,
      builtAt: new Date().toISOString(),
      source: "test",
      tables: [],
      implicitEdges: [],
      viewSourceRows: [],
      sysCatalog: []
    } as Parameters<typeof CatalogGraph.fromSnapshot>[0]
    const h = host(["DEV"], "dev")
    h.catalog.instances.set("DEV", CatalogGraph.fromSnapshot(emptySnap))
    expect(getCatalog(h, "dev")).toBe(getCatalog(h, "DEV"))
  })
})

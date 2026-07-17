import { describe, expect, it } from "vitest"
import type { AgentHost } from "../src/runtime/runtime.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import { resolveEffectiveMssqlConnection } from "../src/tools/catalog/effective-connection.js"

function hostWithConnections(names: string[], defaultConn: string | null): AgentHost {
  const instances = new Map<string, CatalogGraph>()
  const emptySnap = {
    version: 7,
    builtAt: new Date().toISOString(),
    source: "test",
    tables: [],
    implicitEdges: [],
    viewSourceRows: [],
    sysCatalog: []
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0]
  for (const n of names) {
    instances.set(n, CatalogGraph.fromSnapshot(emptySnap))
  }
  return {
    mssql: { databases: new Map(names.map((n) => [n, {} as never])), defaultConnection: { value: defaultConn } },
    catalog: { instances, defaultCachePath: { value: undefined } }
  } as unknown as AgentHost
}

describe("resolveEffectiveMssqlConnection", () => {
  it("maps lowercase MSSQL_DEFAULT_CONNECTION to canonical DEV catalog key", () => {
    const h = hostWithConnections(["DEV", "UAT"], "dev")
    expect(resolveEffectiveMssqlConnection(h, "top bankers")).toBe("DEV")
  })

  it("maps goal token dev to canonical connection", () => {
    const h = hostWithConnections(["DEV", "UAT"], null)
    expect(resolveEffectiveMssqlConnection(h, "show revenue on dev")).toBe("DEV")
  })
})

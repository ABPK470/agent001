import { describe, expect, it } from "vitest"
import {
  CONNECTOR_KINDS,
  ENABLED_CONNECTOR_KINDS,
  getConnectorKind,
  isConnectorKindId,
  maskConnectorConfig,
  SECRET_MASK,
  toConnectorId,
  validateConnectorConfig,
  withConnectorConfigDefaults,
} from "./connectors.js"

describe("connector kind catalogue", () => {
  it("exposes the enabled kinds (mssql + the Bridge adapters)", () => {
    expect(ENABLED_CONNECTOR_KINDS.map((k) => k.id)).toEqual([
      "mssql",
      "postgres",
      "databricks",
      "azure",
      "aws",
      "denodo",
      "httpApi",
      "ftp",
      "aqueduct",
      "webhdfs",
    ])
  })

  it("every kind has a unique id and a non-empty config schema", () => {
    const ids = new Set<string>()
    for (const kind of CONNECTOR_KINDS) {
      expect(ids.has(kind.id)).toBe(false)
      ids.add(kind.id)
      expect(kind.configSchema.length).toBeGreaterThan(0)
    }
  })

  it("isConnectorKindId narrows known ids only", () => {
    expect(isConnectorKindId("mssql")).toBe(true)
    expect(isConnectorKindId("postgres")).toBe(true)
    expect(isConnectorKindId("nope")).toBe(false)
  })

  it("getConnectorKind resolves a known id", () => {
    expect(getConnectorKind("mssql")?.displayName).toBe("SQL Server")
    expect(getConnectorKind("nope" as never)).toBeUndefined()
  })
})

describe("validateConnectorConfig", () => {
  it("rejects a missing required mssql field", () => {
    const result = validateConnectorConfig("mssql", { host: null, database: "x" })
    expect(result.ok).toBe(false)
    expect(result.missing).toContain("host")
  })

  it("accepts a complete mssql config", () => {
    const result = validateConnectorConfig("mssql", {
      host: "db",
      port: 1433,
      database: "mymi",
      user: "sa",
      password: "pw",
      domain: null,
      encrypt: true,
      trustServerCertificate: true,
      writeEnabled: false,
    })
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
  })
})

describe("withConnectorConfigDefaults", () => {
  it("fills schema defaults and nulls missing optional fields", () => {
    const config = withConnectorConfigDefaults("mssql", { host: "db", database: "mymi" })
    expect(config["host"]).toBe("db")
    expect(config["database"]).toBe("mymi")
    expect(config["port"]).toBe(1433)
    expect(config["encrypt"]).toBe(true)
    expect(config["writeEnabled"]).toBe(false)
    expect(config["domain"]).toBeNull()
  })
})

describe("maskConnectorConfig", () => {
  it("masks only password-typed fields", () => {
    const masked = maskConnectorConfig("mssql", {
      host: "db",
      password: "supersecret",
      user: "sa",
    })
    expect(masked["password"]).toBe(SECRET_MASK)
    expect(masked["host"]).toBe("db")
    expect(masked["user"]).toBe("sa")
  })

  it("leaves empty secrets unmasked", () => {
    const masked = maskConnectorConfig("mssql", { host: "db", password: "" })
    expect(masked["password"]).toBe("")
  })
})

describe("toConnectorId", () => {
  it("slugifies labels to kebab-case", () => {
    expect(toConnectorId("Production DB")).toBe("production-db")
    expect(toConnectorId("  My_Env  ")).toBe("my-env")
    expect(toConnectorId("a.b/c")).toBe("a-b-c")
  })
})

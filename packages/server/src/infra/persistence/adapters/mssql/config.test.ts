import { describe, expect, it } from "vitest"
import { resolveMssqlPlatformConfig } from "./config.js"

describe("resolveMssqlPlatformConfig", () => {
  it("requires server, database, and user", () => {
    expect(() => resolveMssqlPlatformConfig({})).toThrow(/MIA_PLATFORM_MSSQL_SERVER/)
  })

  it("maps env into platform config", () => {
    const cfg = resolveMssqlPlatformConfig({
      MIA_PLATFORM_MSSQL_SERVER: "db.example",
      MIA_PLATFORM_MSSQL_DATABASE: "mia",
      MIA_PLATFORM_MSSQL_USER: "mia_app",
      MIA_PLATFORM_MSSQL_PASSWORD: "secret",
      MIA_PLATFORM_MSSQL_PORT: "14333",
      MIA_PLATFORM_MSSQL_ENCRYPT: "false",
      MIA_PLATFORM_MSSQL_TRUST_SERVER_CERTIFICATE: "0",
    })
    expect(cfg).toEqual({
      server: "db.example",
      port: 14333,
      database: "mia",
      user: "mia_app",
      password: "secret",
      encrypt: false,
      trustServerCertificate: false,
    })
  })
})

import { afterEach, describe, expect, it } from "vitest"

import {
  _resetPlatformStoreCacheForTests,
  assertPlatformStoreReady,
  getPlatformStore,
} from "./platform-store.js"

describe("platform-store composition", () => {
  afterEach(() => {
    _resetPlatformStoreCacheForTests()
    delete process.env["MIA_PLATFORM_STORE"]
  })

  it("returns sqlite store by default", () => {
    expect(assertPlatformStoreReady({})).toBe("sqlite")
    expect(getPlatformStore().kind).toBe("sqlite")
  })

  it("allows mssql and postgres at assert", () => {
    expect(assertPlatformStoreReady({ MIA_PLATFORM_STORE: "mssql" })).toBe("mssql")
    expect(assertPlatformStoreReady({ MIA_PLATFORM_STORE: "postgres" })).toBe("postgres")
  })

  it("requires openConfiguredPlatformStore before getPlatformStore for server RDBMS", () => {
    process.env["MIA_PLATFORM_STORE"] = "mssql"
    expect(() => getPlatformStore()).toThrow(/not open/)
    process.env["MIA_PLATFORM_STORE"] = "postgres"
    expect(() => getPlatformStore()).toThrow(/not open/)
  })
})

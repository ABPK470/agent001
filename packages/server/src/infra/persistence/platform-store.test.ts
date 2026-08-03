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

  it("allows mssql at assert; refuses postgres", () => {
    expect(assertPlatformStoreReady({ MIA_PLATFORM_STORE: "mssql" })).toBe("mssql")
    expect(() => assertPlatformStoreReady({ MIA_PLATFORM_STORE: "postgres" })).toThrow(
      /not ready/,
    )
  })

  it("requires openConfiguredPlatformStore before getPlatformStore for mssql", () => {
    process.env["MIA_PLATFORM_STORE"] = "mssql"
    expect(() => getPlatformStore()).toThrow(/not open/)
  })
})

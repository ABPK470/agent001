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

  it("refuses unimplemented mssql/postgres kinds at boot assert", () => {
    expect(() => assertPlatformStoreReady({ MIA_PLATFORM_STORE: "mssql" })).toThrow(/not ready/)
    expect(() => assertPlatformStoreReady({ MIA_PLATFORM_STORE: "postgres" })).toThrow(/not ready/)
  })
})

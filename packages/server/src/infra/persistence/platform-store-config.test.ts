import { describe, expect, it } from "vitest"
import { resolvePlatformStoreKind } from "./platform-store-config.js"

describe("resolvePlatformStoreKind", () => {
  it("defaults to sqlite", () => {
    expect(resolvePlatformStoreKind({})).toBe("sqlite")
  })

  it("accepts mssql and postgres", () => {
    expect(resolvePlatformStoreKind({ MIA_PLATFORM_STORE: "mssql" })).toBe("mssql")
    expect(resolvePlatformStoreKind({ MIA_PLATFORM_STORE: "Postgres" })).toBe("postgres")
  })

  it("rejects unknown kinds", () => {
    expect(() => resolvePlatformStoreKind({ MIA_PLATFORM_STORE: "mongo" })).toThrow(/MIA_PLATFORM_STORE/)
  })
})

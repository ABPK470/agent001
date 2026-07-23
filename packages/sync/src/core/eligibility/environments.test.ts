import { describe, expect, it } from "vitest"

import {
  assertNoRemovedSyncEnvironmentFields,
  assertSupportedSyncDirection,
  findRemovedSyncEnvironmentFields,
  normalizeStoredSyncEnvironment,
  withPermissionDefaults,
} from "./environments.js"

describe("removed sync environment fields", () => {
  it("detects syncAllowlist as removed", () => {
    expect(findRemovedSyncEnvironmentFields({ syncAllowlist: [] })).toEqual(["syncAllowlist"])
  })

  it("rejects syncAllowlist on config ingest", () => {
    expect(() => assertNoRemovedSyncEnvironmentFields({ syncAllowlist: ["a@b.com"] }, "test")).toThrow(
      /removed field "syncAllowlist"/,
    )
  })

  it("strips syncAllowlist when normalizing stored JSON", () => {
    const env = normalizeStoredSyncEnvironment("UAT", {
      name: "UAT",
      displayName: "UAT",
      color: "teal",
      role: "both",
      ringOrder: 1,
      syncAllowlist: ["ghost@example.com"],
      allowedSyncEnvironments: ["DEV"],
    })
    expect("syncAllowlist" in env).toBe(false)
    expect(env.allowedSyncEnvironments).toEqual(["DEV"])
  })
})

describe("assertSupportedSyncDirection", () => {
  it("allows explicitly configured connections", () => {
    const source = withPermissionDefaults({ name: "UAT", role: "both", allowedSyncEnvironments: ["DEV"] })
    const target = withPermissionDefaults({ name: "DEV", role: "both" })

    expect(() => assertSupportedSyncDirection(source, target)).not.toThrow()
  })

  it("rejects connections not present in the source allowlist", () => {
    const source = withPermissionDefaults({ name: "DEV", role: "both", allowedSyncEnvironments: [] })
    const target = withPermissionDefaults({ name: "UAT", role: "both" })

    expect(() => assertSupportedSyncDirection(source, target)).toThrow(
      'Unsupported sync direction "DEV -> UAT". Allowed connections for DEV: none.'
    )
  })

  it("allows unrestricted sources when no direction policy is configured", () => {
    const source = withPermissionDefaults({ name: "UAT", role: "both", allowedSyncEnvironments: null })
    const target = withPermissionDefaults({ name: "PROD", role: "both" })

    expect(() => assertSupportedSyncDirection(source, target)).not.toThrow()
  })
})

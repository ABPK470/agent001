import { describe, expect, it } from "vitest"

import { assertSupportedSyncDirection, withPermissionDefaults } from "./environments.js"

describe("assertSupportedSyncDirection", () => {
  it("allows explicitly configured targets", () => {
    const source = withPermissionDefaults({ name: "UAT", role: "both", allowedSyncTargets: ["DEV"] })
    const target = withPermissionDefaults({ name: "DEV", role: "both" })

    expect(() => assertSupportedSyncDirection(source, target)).not.toThrow()
  })

  it("rejects targets not present in the source allowlist", () => {
    const source = withPermissionDefaults({ name: "DEV", role: "both", allowedSyncTargets: [] })
    const target = withPermissionDefaults({ name: "UAT", role: "both" })

    expect(() => assertSupportedSyncDirection(source, target)).toThrow(
      'Unsupported sync direction "DEV -> UAT". Allowed targets for DEV: none.'
    )
  })

  it("allows unrestricted sources when no direction policy is configured", () => {
    const source = withPermissionDefaults({ name: "UAT", role: "both", allowedSyncTargets: null })
    const target = withPermissionDefaults({ name: "PROD", role: "both" })

    expect(() => assertSupportedSyncDirection(source, target)).not.toThrow()
  })
})

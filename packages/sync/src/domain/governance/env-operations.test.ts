import { describe, expect, it } from "vitest"

import { withPermissionDefaults } from "../environments.js"
import { assertEnvOperationAllowed } from "./env-operations.js"

describe("assertEnvOperationAllowed", () => {
  it("allows operations listed on the environment", () => {
    const env = withPermissionDefaults({ name: "DEV" })
    expect(() => assertEnvOperationAllowed(env, "sync_custom_sql")).not.toThrow()
    expect(() => assertEnvOperationAllowed(env, "sync_shell_execute")).not.toThrow()
  })

  it("denies operations missing from locked-down environments", () => {
    const env = withPermissionDefaults({ name: "UAT" })
    expect(() => assertEnvOperationAllowed(env, "sync_custom_sql")).toThrow(/sync_custom_sql/)
    expect(() => assertEnvOperationAllowed(env, "sync_shell_execute")).toThrow(/sync_shell_execute/)
  })

  it("allows when explicitly configured on UAT", () => {
    const env = withPermissionDefaults({
      name: "UAT",
      allowedOperations: ["sync_preview", "sync_custom_sql", "sync_shell_execute"],
    })
    expect(() => assertEnvOperationAllowed(env, "sync_custom_sql")).not.toThrow()
    expect(() => assertEnvOperationAllowed(env, "sync_shell_execute")).not.toThrow()
  })
})

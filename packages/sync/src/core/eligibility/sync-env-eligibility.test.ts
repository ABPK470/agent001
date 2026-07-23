import { describe, expect, it } from "vitest"

import { withPermissionDefaults } from "../../core/eligibility/environments.js"
import {
  isSyncDirectionAllowed,
  isSyncEnvSelectableAsSource,
  isSyncEnvSelectableAsTarget,
  listSyncSourceOptions,
  listSyncTargetOptions,
} from "./sync-env-eligibility.js"

describe("sync-env-eligibility", () => {
  const ready = new Set(["dev", "uat"])

  const dev = withPermissionDefaults({
    name: "dev",
    connectorId: "dev",
    role: "both",
    allowedSyncEnvironments: [],
  })
  const uat = withPermissionDefaults({
    name: "uat",
    connectorId: "uat",
    role: "both",
    allowedSyncEnvironments: ["dev"],
  })
  const prod = withPermissionDefaults({
    name: "prod",
    connectorId: "prod",
    role: "both",
    allowedSyncEnvironments: null,
  })
  const sourceOnly = withPermissionDefaults({
    name: "src",
    connectorId: "dev",
    role: "source",
    allowedSyncEnvironments: null,
  })

  it("requires role + ready connector for source/target", () => {
    expect(isSyncEnvSelectableAsSource(dev, ready)).toBe(true)
    expect(isSyncEnvSelectableAsTarget(dev, ready)).toBe(true)
    expect(isSyncEnvSelectableAsSource(prod, ready)).toBe(false) // connector not ready
    expect(isSyncEnvSelectableAsTarget(sourceOnly, ready)).toBe(false) // source-only
  })

  it("direction policy filters target options when source is set", () => {
    const envs = [dev, uat, prod]
    expect(listSyncSourceOptions(envs, ready).map((e) => e.name)).toEqual(["dev", "uat"])
    expect(listSyncTargetOptions(envs, ready, uat).map((e) => e.name)).toEqual(["dev"])
    expect(listSyncTargetOptions(envs, ready, dev).map((e) => e.name)).toEqual([])
    expect(isSyncDirectionAllowed(uat, dev)).toBe(true)
    expect(isSyncDirectionAllowed(dev, uat)).toBe(false)
  })
})

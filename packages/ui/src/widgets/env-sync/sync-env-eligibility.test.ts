import { describe, expect, it } from "vitest"
import {
  clampSyncDirectionSelection,
  listSyncSourceOptions,
  listSyncTargetOptions,
} from "./sync-env-eligibility.js"
import type { SyncEnvironment } from "../../types"

function env(
  name: string,
  patch: Partial<SyncEnvironment> = {},
): SyncEnvironment {
  return {
    name,
    displayName: name,
    role: "both",
    connectorReady: true,
    allowedSyncEnvironments: null,
    ...patch,
  } as SyncEnvironment
}

describe("listSyncSourceOptions", () => {
  it("excludes target-only and not-ready connectors", () => {
    const rows = [
      env("dev"),
      env("uat", { role: "target" }),
      env("prod", { connectorReady: false }),
    ]
    expect(listSyncSourceOptions(rows).map((e) => e.name)).toEqual(["dev"])
  })
})

describe("listSyncTargetOptions", () => {
  it("applies source allowedSyncEnvironments allow-list", () => {
    const rows = [
      env("dev", { allowedSyncEnvironments: ["uat"] }),
      env("uat"),
      env("prod"),
    ]
    expect(listSyncTargetOptions(rows, "dev").map((e) => e.name)).toEqual(["uat"])
  })

  it("null allow-list means any ready non-source-only target", () => {
    const rows = [env("dev"), env("uat"), env("prod", { role: "source" })]
    // role "both" stays eligible as target; source-only "prod" is excluded.
    expect(listSyncTargetOptions(rows, "dev").map((e) => e.name)).toEqual(["dev", "uat"])
  })
})

describe("clampSyncDirectionSelection", () => {
  it("keeps valid From/To", () => {
    const rows = [env("dev"), env("uat")]
    expect(clampSyncDirectionSelection(rows, "dev", "uat")).toEqual({
      source: "dev",
      target: "uat",
    })
  })

  it("re-picks To when direction policy removes the current target", () => {
    const rows = [
      env("dev", { allowedSyncEnvironments: ["uat"] }),
      env("uat"),
      env("prod"),
    ]
    expect(clampSyncDirectionSelection(rows, "dev", "prod")).toEqual({
      source: "dev",
      target: "uat",
    })
  })
})

import { describe, expect, it } from "vitest"

import type { MigrationRunner, MigrationStep } from "../src/migrations.js"

describe("MigrationRunner contract", () => {
  it("shapes a sqlite-style runner", async () => {
    const steps: MigrationStep<null>[] = [
      { version: 1, name: "baseline", up: () => {} },
      { version: 2, name: "followup", up: () => {} },
    ]
    const applied = new Set<number>()
    const runner: MigrationRunner = {
      dialect: "sqlite",
      applyPending() {
        for (const step of steps) {
          if (applied.has(step.version)) continue
          step.up(null)
          applied.add(step.version)
        }
      },
      list() {
        return steps.map((s) => ({
          version: s.version,
          name: s.name,
          appliedAt: applied.has(s.version) ? "now" : null,
        }))
      },
    }
    runner.applyPending()
    expect(runner.list()).toEqual([
      { version: 1, name: "baseline", appliedAt: "now" },
      { version: 2, name: "followup", appliedAt: "now" },
    ])
  })
})

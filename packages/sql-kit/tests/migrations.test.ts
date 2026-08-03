import { describe, expect, it } from "vitest"

import type { MigrationRunner, MigrationStep, MultiDialectMigrationStep } from "../src/migrations.js"
import { applyMultiDialectPending, upForDialect } from "../src/migrations.js"

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

  it("resolves dialect-specific ups for multi-dialect steps", () => {
    const step: MultiDialectMigrationStep = {
      version: 1,
      name: "baseline",
      up: {
        sqlite: () => {},
        postgres: () => {},
      },
    }
    expect(upForDialect(step, "sqlite")).toBeTypeOf("function")
    expect(upForDialect(step, "postgres")).toBeTypeOf("function")
    expect(upForDialect(step, "mssql")).toBeNull()
  })

  it("applies pending multi-dialect steps in version order", async () => {
    const seen: number[] = []
    const steps: MultiDialectMigrationStep[] = [
      { version: 2, name: "b", up: { mssql: () => { seen.push(2) } } },
      { version: 1, name: "a", up: { mssql: () => { seen.push(1) } } },
    ]
    const applied = new Set<number>()
    await applyMultiDialectPending({
      dialect: "mssql",
      steps,
      executor: null,
      applied: {
        has: (v) => applied.has(v),
        record: (id) => { applied.add(id.version) },
      },
    })
    expect(seen).toEqual([1, 2])
    expect(applied.has(1)).toBe(true)
  })

  it("refuses steps missing the requested dialect body", async () => {
    await expect(
      applyMultiDialectPending({
        dialect: "mssql",
        steps: [{ version: 1, name: "only-sqlite", up: { sqlite: () => {} } }],
        executor: null,
        applied: { has: () => false, record: () => {} },
      }),
    ).rejects.toThrow(/no "mssql" body/)
  })
})

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const planTablesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "PlanTables.tsx",
)

function readPlanTablesSource(): string {
  return readFileSync(planTablesPath, "utf8")
}

describe("PlanTables regression guards", () => {
  it("uses shared preview/full value helpers for sample cells", () => {
    const src = readPlanTablesSource()
    expect(src).toContain('from "./plan-table-values"')
    expect(src).toContain("formatCellPreview")
    expect(src).toContain("formatCellFull")
    expect(src).toContain("SampleValueDetailModal")
    expect(src).toContain("SampleCell")
  })

  it("keeps compact table layout classes on sample rows", () => {
    const src = readPlanTablesSource()
    expect(src).toContain("whitespace-nowrap")
    expect(src).toContain("overflow-x-auto show-scrollbar")
    expect(src).toContain("INITIAL_ROWS = 5")
  })

  it("opens detail modal from sample cell click without replacing table preview", () => {
    const src = readPlanTablesSource()
    expect(src).toContain("setDetail(")
    expect(src).toContain('type="button"')
    expect(src).toContain("ModalShell")
    expect(src).not.toMatch(/formatCellFull\([^)]+\)[\s\S]{0,80}<td/)
  })
})

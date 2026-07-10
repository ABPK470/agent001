import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const planTablesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "PlanTables.tsx",
)
const planSampleRowModalPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "PlanSampleRowModal.tsx",
)

function readSource(path: string): string {
  return readFileSync(path, "utf8")
}

describe("PlanTables regression guards", () => {
  it("uses shared preview helpers and row-level detail modal", () => {
    const src = readSource(planTablesPath)
    expect(src).toContain('from "./plan-table-values"')
    expect(src).toContain("formatCellPreview")
    expect(src).toContain("PlanSampleRowModal")
    expect(src).toContain("SampleRowDetail")
    expect(src).not.toContain("SampleCell")
    expect(src).not.toContain("SampleValueDetailModal")
  })

  it("keeps compact table layout classes on sample rows", () => {
    const src = readSource(planTablesPath)
    expect(src).toContain("whitespace-nowrap")
    expect(src).toContain("overflow-x-auto show-scrollbar")
    expect(src).toContain("INITIAL_ROWS = 5")
    expect(src).toContain("max-w-xs truncate")
  })

  it("opens row detail from tr click without per-cell buttons", () => {
    const src = readSource(planTablesPath)
    expect(src).toContain("setDetail({ table, kind, rowIndex: index, sample })")
    expect(src).toContain('title="View full row"')
    expect(src).not.toContain('type="button"')
  })
})

describe("PlanSampleRowModal regression guards", () => {
  it("shows full row diff with current and replacement columns for updates", () => {
    const src = readSource(planSampleRowModalPath)
    expect(src).toContain("Current (target)")
    expect(src).toContain("After sync (source)")
    expect(src).toContain("formatCellFull")
    expect(src).toContain("sampleRowColumns")
    expect(src).toContain("changed")
  })

  it("shows all column values for insert and delete rows", () => {
    const src = readSource(planSampleRowModalPath)
    expect(src).toContain("Value to insert")
    expect(src).toContain("Value to delete")
  })
})

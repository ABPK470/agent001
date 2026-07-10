import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  PLAN_ROW_DIFF_BODY_CLASS,
  PLAN_ROW_DIFF_SUMMARY_CLASS,
} from "./PlanSampleRowModal"

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
  it("uses diff-first layout with fixed summary and scrollable body", () => {
    const src = readSource(planSampleRowModalPath)
    expect(src).toContain("PLAN_ROW_DIFF_SUMMARY_CLASS")
    expect(src).toContain("PLAN_ROW_DIFF_BODY_CLASS")
    expect(PLAN_ROW_DIFF_SUMMARY_CLASS).toContain("shrink-0")
    expect(PLAN_ROW_DIFF_BODY_CLASS).toContain("overflow-y-auto")
    expect(src).not.toContain("sticky top-0")
  })

  it("shows side-by-side before/after panels for changed columns", () => {
    const src = readSource(planSampleRowModalPath)
    expect(src).toContain("DiffFieldBlock")
    expect(src).toContain("Current (target)")
    expect(src).toContain("After sync (source)")
    expect(src).toContain("partitionSampleRowColumns")
    expect(src).toContain("will change")
  })

  it("collapses unchanged columns behind an explicit expand control", () => {
    const src = readSource(planSampleRowModalPath)
    expect(src).toContain("unchanged column")
    expect(src).toContain("showUnchanged")
    expect(src).toContain("UnchangedFieldRow")
  })

  it("shows all column values for insert and delete rows", () => {
    const src = readSource(planSampleRowModalPath)
    expect(src).toContain("InsertDeleteRowDiff")
    expect(src).toContain("Value to insert")
    expect(src).toContain("Value to delete")
    expect(src).toContain("formatCellFull")
  })
})

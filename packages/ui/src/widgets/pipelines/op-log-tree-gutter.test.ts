/**
 * Pipelines left-tree gutter — Trace dialect parity.
 *
 * Root cause we lock out: killing `.trace-tree-row__node-cell` base-pad
 * (`padding-left: 0 !important`) to squeeze right-edge pills also stole the
 * left air, so chevrons sat ~16px from the sidebar border instead of ~32px.
 *
 * Geometry (shared with Trace):
 *   panel edge → button hpad (16) → node-cell base-pad (16) [+ depth×indent]
 *   → chevron. Selection rail stays at left: 0 on the row.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  TRACE_TREE_BASE_PAD_PX,
  TRACE_TREE_HPAD_PX,
  TRACE_TREE_INDENT_PX,
  TRACE_TREE_ROOT_INSET_PX,
  traceTreeNodeCellStyle,
} from "../trace/trace-tree-guides"

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, "../../boot/index.css")
const listRowPath = join(here, "OperationLogPipelineListRow.tsx")
const activityRowPath = join(here, "OperationLogActivityTreeRow.tsx")
const opsPath = join(here, "../OperationLog.tsx")
const traceGuidesPath = join(here, "../trace/trace-tree-guides.ts")
const traceTreeCssNeedle = "var(--trace-tree-base-pad, 16px) + var(--trace-tree-depth, 0) * var(--trace-tree-indent, 20px)"

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("pipelines left-tree gutter — Trace dialect", () => {
  it("documents the root chevron inset (hpad + base-pad)", () => {
    expect(TRACE_TREE_HPAD_PX).toBe(16)
    expect(TRACE_TREE_BASE_PAD_PX).toBe(16)
    expect(TRACE_TREE_INDENT_PX).toBe(20)
    expect(TRACE_TREE_ROOT_INSET_PX).toBe(32)
  })

  it("hosts Trace left-tree tokens on .op-log-split-list (parity with .trace-split-tree)", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.op-log-split-list\s*\{[^}]*--trace-tree-hpad:\s*16px/s,
    )
    expect(css).toMatch(
      /\.op-log-split-list\s*\{[^}]*--trace-tree-base-pad:\s*16px/s,
    )
    expect(css).toMatch(
      /\.op-log-split-list\s*\{[^}]*--trace-tree-indent:\s*20px/s,
    )
    expect(css).toMatch(
      /\.trace-split-tree\s*\{[^}]*--trace-tree-hpad:\s*16px/s,
    )
  })

  it("never zeroes Trace node-cell left pad on Pipelines rows", () => {
    const css = read(cssPath)
    const pipelinesNodeCell = css.match(
      /\.op-log-pipeline-list-row \.trace-tree-row__node-cell,[\s\S]*?\.op-log-activity-tree-row__node-cell\s*\{[^}]*\}/,
    )?.[0]
    expect(pipelinesNodeCell).toBeTruthy()
    expect(pipelinesNodeCell).not.toMatch(/padding-left:\s*0\s*!important/)
    expect(pipelinesNodeCell).not.toMatch(/padding-right:\s*0\s*!important/)
    // Trace formula still owns left inset for both widgets.
    expect(css).toContain(traceTreeCssNeedle)
  })

  it("TREE header + day caps share the same hpad token as rows", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.op-log-split-list__cap\s*\{[^}]*padding-inline:\s*var\(--trace-tree-hpad/s,
    )
    expect(css).toMatch(
      /\.op-log-split-list-scroll \.review-group-label\s*\{[^}]*padding-inline:\s*var\(--trace-tree-hpad/s,
    )
  })

  it("wires depth via CSS vars — not inline paddingLeft", () => {
    const listRow = read(listRowPath)
    const activity = read(activityRowPath)
    expect(listRow).toContain("traceTreeNodeCellStyle(0)")
    expect(activity).toContain("traceTreeNodeCellStyle(treeDepth)")
    expect(activity).toContain("Math.max(0, depth - 1)")
    expect(activity).not.toContain("paddingLeft")
    expect(listRow).not.toContain("paddingLeft")
  })

  it("traceTreeNodeCellStyle emits the shared depth tokens", () => {
    const style = traceTreeNodeCellStyle(2)
    expect(style).toMatchObject({
      "--trace-tree-depth": 2,
      "--trace-tree-base-pad": "16px",
      "--trace-tree-indent": "20px",
    })
    expect(traceTreeNodeCellStyle(-1)["--trace-tree-depth" as string]).toBe(0)
  })

  it("keeps selection rail on the row edge (bar ≠ content inset)", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.trace-tree-row\.is-selected::before\s*\{[^}]*left:\s*0/s,
    )
    expect(css).toMatch(
      /\.op-log-activity-tree-row\.is-selected::before\s*\{[^}]*left:\s*0/s,
    )
  })

  it("protects right-edge pills without stealing left gutter", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.op-log-pipeline-list-row__btn,[\s\S]*?min-width:\s*0\s*!important/s,
    )
    expect(css).toMatch(
      /\.op-log-pipeline-list-row \.op-log-status-pill,[\s\S]*?margin-left:\s*auto/s,
    )
    expect(css).toContain("padding: 0.3rem 1.25rem 0.3rem var(--trace-tree-hpad, 16px)")
  })

  it("split shell still mounts the list host that carries the tokens", () => {
    const ops = read(opsPath)
    expect(ops).toContain("op-log-split-list widget-split-sidebar")
    expect(ops).toContain("op-log-split-list__cap")
    expect(ops).toContain("OperationLogPipelineListRow")
    expect(ops).toContain("OperationLogActivityTreeRow")
    expect(read(traceGuidesPath)).toContain("TRACE_TREE_ROOT_INSET_PX")
  })
})

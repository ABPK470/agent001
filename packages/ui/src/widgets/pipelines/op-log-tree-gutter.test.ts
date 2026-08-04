/**
 * Pipelines left-tree gutter — operator review kit parity.
 *
 * Root cause we lock out: killing node-cell base-pad
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
  REVIEW_TREE_BASE_PAD_PX,
  REVIEW_TREE_HPAD_PX,
  REVIEW_TREE_INDENT_PX,
  REVIEW_TREE_ROOT_INSET_PX,
  reviewTreeNodeCellStyle,
} from "../../components/review/review-tree-geometry"

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, "../../boot/index.css")
const listRowPath = join(here, "OperationLogPipelineListRow.tsx")
const activityRowPath = join(here, "OperationLogActivityTreeRow.tsx")
const opsPath = join(here, "../OperationLog.tsx")
const geometryPath = join(here, "../../components/review/review-tree-geometry.ts")
const reviewTreeCssNeedle =
  "var(--review-tree-base-pad, 16px) + var(--review-tree-depth, 0) * var(--review-tree-indent, 20px)"

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("pipelines left-tree gutter — review kit", () => {
  it("documents the root chevron inset (hpad + base-pad)", () => {
    expect(REVIEW_TREE_HPAD_PX).toBe(16)
    expect(REVIEW_TREE_BASE_PAD_PX).toBe(16)
    expect(REVIEW_TREE_INDENT_PX).toBe(20)
    expect(REVIEW_TREE_ROOT_INSET_PX).toBe(32)
  })

  it("hosts review left-tree tokens on .review-operator .review-split-list", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.review-operator \.review-split-list\s*\{[^}]*--review-tree-hpad:\s*16px/s,
    )
    expect(css).toMatch(
      /\.review-operator \.review-split-list\s*\{[^}]*--review-tree-base-pad:\s*16px/s,
    )
    expect(css).toMatch(
      /\.review-operator \.review-split-list\s*\{[^}]*--review-tree-indent:\s*20px/s,
    )
  })

  it("never zeroes review node-cell left pad on Pipelines rows", () => {
    const css = read(cssPath)
    expect(css).toContain(reviewTreeCssNeedle)
    const nodeCell = css.match(/\.review-tree-row__node-cell\s*\{[^}]*\}/)?.[0]
    expect(nodeCell).toBeTruthy()
    expect(nodeCell).not.toMatch(/padding-left:\s*0\s*!important/)
  })

  it("day groups are sticky full-width section dividers (no card boxes)", () => {
    const css = read(cssPath)
    const ops = read(opsPath)
    expect(css).toContain(".op-log-day-cap")
    expect(css).not.toContain(".op-log-day-card")
    expect(css).toMatch(
      /\.op-log-day-cap\s*\{[^}]*padding-inline:\s*var\(--review-tree-hpad/s,
    )
    expect(ops).toContain("op-log-day-cap")
    expect(ops).not.toContain("dayCardClass")
    expect(ops).not.toContain("op-log-day-card")
  })

  it("activity rows use Trace dialect — title/subtitle stack, no guideSlots", () => {
    const activity = read(activityRowPath)
    const ops = read(opsPath)
    expect(activity).toContain("ReviewTreeRow")
    expect(activity).toContain("resolveActivityTreeVisual")
    expect(activity).toContain("OpLogStatusDot")
    expect(activity).toContain("hasSubtitle")
    expect(activity).toContain("subtitle=")
    expect(activity).not.toContain("guideSlots")
    expect(activity).not.toContain(" · ")
    expect(ops).not.toContain("guideSlots=")
  })

  it("nests with whitespace depth padding — Trace dialect, not ├└ hairlines", () => {
    const activity = read(activityRowPath)
    const css = read(cssPath)
    expect(activity).not.toContain("guideSlots")
    // Depth indent still comes from shared review node-cell tokens.
    expect(css).toContain(reviewTreeCssNeedle)
    expect(css).toMatch(
      /\.review-operator \.op-log-activity-tree-row \.review-tree-row__subtitle\s*\{[^}]*font-size:\s*0\.6875rem/s,
    )
  })

  it("wires depth via CSS vars — not inline paddingLeft", () => {
    const listRow = read(listRowPath)
    const activity = read(activityRowPath)
    expect(listRow).toContain("ReviewTreeRow")
    expect(activity).toContain("ReviewTreeRow")
    expect(activity).not.toContain("depth - 1")
    expect(activity).not.toContain("paddingLeft")
    expect(listRow).not.toContain("paddingLeft")
  })

  it("reviewTreeNodeCellStyle emits the shared depth tokens", () => {
    const style = reviewTreeNodeCellStyle(2)
    expect(style).toMatchObject({
      "--review-tree-depth": 2,
      "--review-tree-base-pad": "16px",
      "--review-tree-indent": "20px",
    })
    expect(reviewTreeNodeCellStyle(-1)["--review-tree-depth" as string]).toBe(0)
  })

  it("keeps selection rail on the row edge (bar ≠ content inset)", () => {
    const css = read(cssPath)
    expect(css).toMatch(/\.review-tree-row\.is-selected::before\s*\{[^}]*left:\s*0/s)
  })

  it("split shell mounts review kit list host with day grouping caps", () => {
    const ops = read(opsPath)
    expect(ops).toContain("review-split-list widget-split-sidebar")
    expect(ops).not.toContain("ReviewTreeHeader")
    expect(ops).toContain("op-log-day-cap")
    expect(ops).toContain("ReviewSplitPane")
    expect(ops).toContain("OperationLogPipelineListRow")
    expect(ops).toContain("OperationLogActivityTreeRow")
    expect(read(geometryPath)).toContain("REVIEW_TREE_ROOT_INSET_PX")
  })
})

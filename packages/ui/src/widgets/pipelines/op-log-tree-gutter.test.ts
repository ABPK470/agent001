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

  it("day caps share the same root inset as depth-0 chevrons", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.review-operator \.review-split-list-scroll \.review-group-label\s*\{[^}]*padding-inline-start:\s*var\(--review-tree-root-inset/s,
    )
  })

  it("activity rows reserve the icon column via ReviewTreeRow", () => {
    const activity = read(activityRowPath)
    expect(activity).toContain("ReviewTreeRow")
    expect(activity).toContain("resolveActivityTreeVisual")
    expect(activity).toContain("OpLogStatusDot")
    expect(activity).toContain("guideSlots")
    expect(activity).not.toContain("activityEntityIcon")
  })

  it("hosts IDE tree guide hairlines on the shared review kit", () => {
    const css = read(cssPath)
    expect(css).toContain(".review-tree-row__guides")
    expect(css).toContain(".review-tree-guide.is-branch")
    expect(css).toContain(".review-tree-guide.is-corner")
    expect(css).toContain("var(--review-tree-line)")
    // Corners paint via backgrounds — abspos %-height drops the └ vertical.
    expect(css).toMatch(/\.review-tree-guide\.is-corner\s*\{[^}]*background-size:\s*1px 50%/s)
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

  it("split shell mounts review kit list host with column header", () => {
    const ops = read(opsPath)
    expect(ops).toContain("review-split-list widget-split-sidebar")
    expect(ops).toContain("ReviewTreeHeader")
    expect(ops).toContain("ReviewSplitPane")
    expect(ops).toContain("OperationLogPipelineListRow")
    expect(ops).toContain("OperationLogActivityTreeRow")
    expect(read(geometryPath)).toContain("REVIEW_TREE_ROOT_INSET_PX")
  })
})

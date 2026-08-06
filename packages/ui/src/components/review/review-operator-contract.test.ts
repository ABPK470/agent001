/**
 * Operator review kit — geometry and presentation contracts.
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
} from "./review-tree-geometry"

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, "../../boot/index.css")
const foldTogglePath = join(here, "ReviewTreeFoldToggle.tsx")
const payloadPath = join(here, "ReviewPayloadBlock.tsx")
const reviewTreeCssNeedle =
  "var(--review-tree-base-pad, 16px) + var(--review-tree-depth, 0) * var(--review-tree-indent, 20px)"

describe("operator review kit contracts", () => {
  const css = readFileSync(cssPath, "utf8")

  it("documents root chevron inset (hpad + base-pad)", () => {
    expect(REVIEW_TREE_HPAD_PX).toBe(16)
    expect(REVIEW_TREE_BASE_PAD_PX).toBe(16)
    expect(REVIEW_TREE_INDENT_PX).toBe(20)
    expect(REVIEW_TREE_ROOT_INSET_PX).toBe(32)
  })

  it("reviewTreeNodeCellStyle emits depth CSS vars — not paddingLeft", () => {
    const style = reviewTreeNodeCellStyle(2)
    expect(style).toMatchObject({
      "--review-tree-depth": 2,
      "--review-tree-base-pad": "16px",
      "--review-tree-indent": "20px",
    })
    expect(reviewTreeNodeCellStyle(-1)["--review-tree-depth" as string]).toBe(0)
  })

  it("CSS owns node-cell inset formula", () => {
    expect(css).toContain(reviewTreeCssNeedle)
    const nodeCell = css.match(/\.review-tree-row__node-cell\s*\{[^}]*\}/)?.[0]
    expect(nodeCell).toBeTruthy()
    expect(nodeCell).not.toMatch(/padding-left:\s*0\s*!important/)
  })

  it("row selection keeps the left rail; pane focus is a top edge", () => {
    expect(css).toMatch(/\.review-tree-row\.is-selected::before\s*\{[^}]*left:\s*0/s)
    expect(css).toMatch(/\.review-tree-row\.is-selected::before\s*\{[^}]*width:\s*2px/s)
    expect(css).toMatch(
      /\.trace-split-tree\.is-pane-focused::before,\s*\n\.trace-split-detail\.is-pane-focused::before\s*\{[^}]*height:\s*2px/s,
    )
  })

  it("fold toggle is a ListChevrons icon button (not Expanded/Collapsed segment)", () => {
    const src = readFileSync(foldTogglePath, "utf8")
    expect(src).toContain("ListChevronsDownUp")
    expect(src).toContain("ListChevronsUpDown")
    expect(src).toContain("widget-toolbar__icon-btn")
    expect(src).not.toContain("SegmentToggle")
    expect(src).not.toContain('label: "Expanded"')
    expect(src).not.toContain('label: "Collapsed"')
  })

  it("payload block uses JsonViewer embedded inline mode", () => {
    const src = readFileSync(payloadPath, "utf8")
    expect(src).toContain("embedded")
    expect(src).toContain("inline")
    expect(src).toContain("copyable")
  })
})

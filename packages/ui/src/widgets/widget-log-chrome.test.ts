import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  WIDGET_LOG_INSET_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
} from "./widget-toolbar"

const here = dirname(fileURLToPath(import.meta.url))

describe("widget log chrome (Event Stream / Pipelines / Trace)", () => {
  it("shares the same inset and toolbar→body gap", () => {
    expect(WIDGET_LOG_INSET_CLASS).toContain("pt-3")
    expect(WIDGET_LOG_INSET_CLASS).toContain("px-3")
    expect(WIDGET_LOG_INSET_CLASS).toContain("pb-1")
    expect(WIDGET_LOG_SHELL_CLASS).toContain(WIDGET_LOG_INSET_CLASS)
    expect(WIDGET_LOG_STACK_CLASS).toContain("gap-3")
  })

  it("review widgets mount WidgetToolbar (not freestyle header columns)", () => {
    const live = readFileSync(join(here, "LiveLogs.tsx"), "utf8")
    const ops = readFileSync(join(here, "operation-log-toolbar.tsx"), "utf8")
    const trace = readFileSync(join(here, "trace/TraceDag.tsx"), "utf8")

    expect(live).toContain("WidgetToolbar")
    expect(live).toContain("WidgetToolbarSearch")
    expect(live).toContain("WidgetToolbarTrailing")

    expect(ops).toContain("WidgetToolbar")
    expect(ops).toContain("WidgetToolbarSearch")
    expect(ops).toContain("FilterSheet")
    expect(ops).toContain("FilterChoiceGrid")
    expect(ops).not.toContain("SegmentToggle")
    expect(ops).not.toContain("LOG_TOOLBAR_CHIP")

    expect(trace).toContain("WidgetToolbar")
    expect(trace).toContain("WidgetToolbarSearch")
    expect(trace).toContain("widget-review-meta")
    expect(trace).not.toContain("trace-search")
    expect(trace).not.toContain('className="trace-toolbar')
  })

  it("shares curved review-tree elbows / meta / JsonViewer dialect", () => {
    const css = readFileSync(join(here, "../boot/index.css"), "utf8")
    const live = readFileSync(join(here, "LiveLogs.tsx"), "utf8")
    const ops = readFileSync(join(here, "OperationLog.tsx"), "utf8")
    const nest = readFileSync(join(here, "pipelines/operation-log-row.tsx"), "utf8")
    const json = readFileSync(join(here, "../components/JsonViewer.tsx"), "utf8")
    const call = readFileSync(join(here, "trace/TraceCall.tsx"), "utf8")

    expect(css).toContain("--review-meta-size")
    expect(css).toContain("--review-tree-line")
    expect(css).toContain("--review-tree-radius")
    expect(css).toContain(".review-tree > .review-tree__item::before")
    expect(css).toContain("border-bottom-left-radius: var(--review-tree-radius)")
    expect(css).toContain("font-size: var(--review-meta-size)")
    expect(css).toContain(".trace-scope-payload")
    expect(css).toContain("--review-chevron-slot")
    expect(css).toContain("--control-h")
    expect(css).toContain("container-name: widget-toolbar")
    expect(css).toContain(".review-chevron-slot")

    expect(live).toContain("review-tree")
    expect(live).toContain("review-tree__item")
    expect(live).toContain("review-chevron-slot")
    expect(live).toContain("review-meta")
    expect(live).toContain("JsonViewer")
    expect(live).not.toContain("border-l-2")
    // Nest flush — no pl-3 before review-tree (stem under content letters).
    expect(live).not.toMatch(/pl-3[\s\S]{0,40}review-tree/)

    expect(ops).toContain("JsonViewer")
    expect(ops).not.toContain("CodeBlock")
    // Activity nest is OpLogRow children — sibling LogNest breaks the stem.
    expect(ops).toMatch(/<OpLogRow[\s\S]*?<LogNest[\s\S]*?<\/OpLogRow>/)
    expect(ops).not.toMatch(/<\/OpLogRow>\s*\{expanded && \(\s*<LogNest/)
    expect(nest).toContain("ReviewTree")
    expect(nest).toContain("ReviewTreeItem")
    expect(nest).toContain("parent OpLogRow")
    expect(nest).toContain("review-chevron-slot")
    expect(nest).not.toContain("pl-3 min-w-0")
    expect(call).toContain("ReviewTree")
    expect(call).toContain("ReviewTreeItem")
    expect(json).toContain("mia-code-block__label")
    // JSON keeps a plain indent rail — curved elbows are for list hierarchy only.
    expect(json).not.toContain("review-tree")

    const foundation = readFileSync(join(here, "../components/ReviewTree.tsx"), "utf8")
    expect(foundation).toContain("ReviewTree")
    expect(foundation).toContain("ReviewTreeItem")
    expect(foundation).toContain("Only *direct* ReviewTreeItem children")
    expect(foundation).toContain("never as a peer of that item")
    expect(foundation).toContain("review-chevron-slot")
  })
})

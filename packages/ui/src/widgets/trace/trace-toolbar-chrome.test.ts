/**
 * Trace toolbar + review-controls chrome contracts.
 *
 * Locks the control band spacing (air above the hairline), toolbar wiring
 * (Tree/Waterfall, search, Expanded/Collapsed, export peer), and meta band
 * structure so regressions like flush-to-divider padding cannot return.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  WIDGET_REVIEW_CONTROLS_CLASS,
  WIDGET_REVIEW_CONTROLS_INSET_CLASS,
} from "../widget-toolbar"

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, "../../boot/index.css")
const dagPath = join(here, "TraceDag.tsx")
const exportPath = join(here, "TraceExportMenu.tsx")
const zenHudPath = join(here, "TraceZenHud.tsx")
const contextPath = join(here, "TraceRunContext.tsx")
const foldTogglePath = join(here, "TraceTreeFoldToggle.tsx")
const openStatePath = join(here, "open-state.ts")
const waterfallPath = join(here, "TraceWaterfallView.tsx")
const kindIconPath = join(here, "trace-kind-icon.ts")
const treeRowPath = join(here, "TraceTreeRow.tsx")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("Trace review-controls spacing — air above the band hairline", () => {
  it("defines shared pad tokens for the review control band", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.widget-review-controls\s*\{[^}]*--review-controls-pad-x:\s*0\.625rem/s,
    )
    expect(css).toMatch(
      /\.widget-review-controls\s*\{[^}]*--review-controls-pad-y:\s*0\.5rem/s,
    )
    expect(css).toMatch(
      /\.widget-review-controls\s*\{[^}]*--review-controls-pad-bottom:\s*0\.625rem/s,
    )
  })

  it("toolbar inset keeps bottom pad before a following meta/filter band", () => {
    const css = read(cssPath)
    // Regression: padding-block … 0 left controls glued to the divider.
    expect(css).toMatch(
      /\.widget-review-controls__inset:not\(:last-child\)\s*\{[^}]*padding-bottom:\s*var\(--review-controls-pad-y\)/s,
    )
    expect(css).toMatch(
      /\.widget-review-controls__inset:last-child\s*\{[^}]*padding-bottom:\s*var\(--review-controls-pad-bottom\)/s,
    )
    expect(css).toMatch(
      /\.widget-review-controls__inset\s*\+\s*\.widget-review-controls__inset\s*\{[^}]*border-top:\s*1px solid var\(--border-subtle\)/s,
    )
  })

  it("strips nested toolbar border/padding inside the review inset (band owns the seam)", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.widget-review-controls__inset\s*>\s*\.widget-toolbar\s*,[\s\S]*?padding:\s*0;[\s\S]*?border-bottom:\s*none/s,
    )
  })
})

describe("Trace toolbar structure + behavior wiring", () => {
  it("mounts review-controls with toolbar inset then optional meta inset", () => {
    const dag = read(dagPath)
    expect(WIDGET_REVIEW_CONTROLS_CLASS).toBe("widget-review-controls")
    expect(WIDGET_REVIEW_CONTROLS_INSET_CLASS).toBe("widget-review-controls__inset")
    expect(dag).toContain("WIDGET_REVIEW_CONTROLS_CLASS")
    expect(dag).toContain("WIDGET_REVIEW_CONTROLS_INSET_CLASS")
    expect(dag).toContain("WidgetToolbar")
    expect(dag).toContain("WidgetToolbarLeading")
    expect(dag).toContain("WidgetToolbarSearch")
    expect(dag).toContain("WidgetToolbarTrailing")
    // Scope chrome outside review-controls; toolbar + meta stay in the band.
    const jsx = dag.slice(dag.indexOf("return ("))
    expect(jsx.indexOf("trace-scope-row")).toBeGreaterThan(-1)
    expect(jsx.indexOf("TraceRunContext")).toBeLessThan(jsx.indexOf("WIDGET_REVIEW_CONTROLS_CLASS"))
    expect(jsx).toMatch(
      /trace-scope-row[\s\S]*?TraceRunContext[\s\S]*?WIDGET_REVIEW_CONTROLS_CLASS[\s\S]*?WidgetToolbar[\s\S]*?widget-review-meta/,
    )
  })

  it("wires Tree / Waterfall view toggle", () => {
    const dag = read(dagPath)
    expect(dag).toContain('{ value: "tree", label: "Tree" }')
    expect(dag).toContain('{ value: "waterfall", label: "Waterfall" }')
    expect(dag).toContain('ariaLabel="Tree or waterfall view"')
    expect(dag).toContain("setViewMode")
    expect(dag).toContain("TraceWaterfallView")
    expect(dag).toMatch(/viewMode === "waterfall"/)
  })

  it("wires fold-all icon toggle to open-state foldMode", () => {
    const dag = read(dagPath)
    const openState = read(openStatePath)
    expect(dag).toContain("ReviewTreeFoldToggle")
    expect(dag).toContain('ariaLabel="Expand or collapse all trace scopes"')
    expect(dag).toContain("onFoldModeChange")
    expect(dag).toContain("openState.foldMode")
    expect(dag).not.toContain('{ value: "expanded", label: "Expanded" }')
    expect(openState).toContain("openStateForFoldMode")
    expect(openState).toContain("expandedOpenState")
    expect(openState).toContain("collapsedOpenState")
  })

  it("search filters the tree with the Trace placeholder", () => {
    const dag = read(dagPath)
    expect(dag).toContain('placeholder="Filter calls, tools, work…"')
    expect(dag).toContain("WidgetToolbarSearch")
    expect(dag).toContain("setSearch")
    expect(dag).toMatch(/onClear=\{\(\) => setSearch\(""\)\}/)
  })

  it("places export download as a trailing peer after the fold icon", () => {
    const dag = read(dagPath)
    const menu = read(exportPath)
    expect(dag).toMatch(
      /ariaLabel="Expand or collapse all trace scopes"\s*\/>\s*<TraceExportMenu/,
    )
    expect(dag).not.toMatch(/trailing=\{[\s\S]*?<TraceExportMenu/)
    expect(menu).toContain('run("txt", false)')
    expect(menu).toContain('run("json", false)')
    expect(menu).toContain('run("txt", true)')
    expect(menu).toContain('run("json", true)')
    expect(menu).toMatch(/Download size=\{14\}/)
  })

  it("hides the review-controls toolbar in zen mode (HUD takes over)", () => {
    const dag = read(dagPath)
    const zen = read(zenHudPath)
    const fold = read(foldTogglePath)
    expect(dag).toMatch(/!isZen \? \([\s\S]*WIDGET_REVIEW_CONTROLS_CLASS/)
    expect(dag).toContain("trace-dag--zen")
    expect(zen).toContain("TraceZenHud")
    expect(zen).toContain("TraceTreeFoldToggle")
    expect(zen).toContain('placeholder="Filter calls, tools, work…"')
    expect(fold).toContain("onFoldModeChange")
  })

  it("scope bar precedes toolbar; meta is telemetry only", () => {
    const dag = read(dagPath)
    const zen = read(zenHudPath)
    const context = read(contextPath)
    expect(dag).toContain("<TraceRunContext />")
    expect(dag).toMatch(
      /<TraceRunContext \/>[\s\S]*?<WidgetToolbar>[\s\S]*?widget-review-meta/,
    )
    expect(dag).toContain("widget-filter-band widget-review-meta")
    expect(dag).toContain("widget-review-meta__stats")
    expect(dag).toContain("widget-review-meta__stat-value")
    // Pickers are not in the meta band — status pill may still use __ids.
    expect(dag).not.toMatch(/widget-review-meta__ids[\s\S]{0,120}TraceRunContext/)
    expect(context).toContain("trace-run-context")
    expect(context).toContain("trace-run-context__pill")
    expect(dag).toContain("TraceScopeDrawer")
    expect(dag).toContain("trace-scope-drawer-toggle")
    expect(zen).toContain("TraceRunContext")
    expect(zen).toContain("compact")
    expect(zen).toContain("scopeDrawerOpen")
  })

  it("waterfall labels use shared kind icons — not Work:/Subagent: text prefixes", () => {
    const waterfall = read(waterfallPath)
    const kindIcon = read(kindIconPath)
    const treeRow = read(treeRowPath)
    const css = read(cssPath)
    expect(kindIcon).toContain("TRACE_KIND_ICON")
    expect(treeRow).toContain("TRACE_KIND_ICON")
    expect(waterfall).toContain("TRACE_KIND_ICON")
    expect(waterfall).toContain("trace-waterfall-row__name")
    expect(waterfall).toContain("waterfallTooltip")
    expect(waterfall).toContain("REDUNDANT_LEADING")
    expect(waterfall).not.toContain("${node.leading}: ${node.name}")
    expect(css).toMatch(
      /\.trace-waterfall-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*9\.5rem\)/s,
    )
    expect(css).toContain(".trace-waterfall-row__icon")
  })
})

/**
 * Regression — review-family chrome + nest dialect
 * (Event Stream / Pipelines / Trace / Threads).
 *
 * Contracts locked here:
 * - One toolbar: leading | search | trailing; search fills & shrinks first
 * - One control height (--control-h) for search / segments / icon buttons
 * - One curved tree: flush nest, stem under .review-chevron-slot center
 * - Prompt prose = .trace-scope-payload (not nested-peer gutter)
 * - Pipelines uses the shared operator review kit (ReviewTreeRow / ReviewSplitPane)
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CONTROL_IDLE, CONTROL_PRESSED, SELECT_TRACK } from "../lib/selection"
import {
  WIDGET_CONTENT_GUTTER_CLASS,
  WIDGET_CONTENT_GUTTER_INNER_CLASS,
  WIDGET_LOG_BODY_CLASS,
  WIDGET_LOG_SCROLL_CLASS,
  WIDGET_LOG_INSET_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
  WIDGET_REVIEW_CONTROLS_CLASS,
  WIDGET_REVIEW_CONTROLS_INSET_CLASS,
} from "./widget-toolbar"

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, "../boot/index.css")
const selectionPath = join(here, "../lib/selection.ts")
const toolbarPath = join(here, "widget-toolbar.tsx")
const livePath = join(here, "LiveLogs.tsx")
const opsPath = join(here, "OperationLog.tsx")
const opsToolbarPath = join(here, "operation-log-toolbar.tsx")
const reviewKitPath = join(here, "../components/review/ReviewTreeRow.tsx")
const nestPath = join(here, "pipelines/operation-log-row.tsx")
const opLogListRowPath = join(here, "pipelines/OperationLogPipelineListRow.tsx")
const traceDagPath = join(here, "trace/TraceDag.tsx")
const traceCallPath = join(here, "trace/TraceCall.tsx")
const traceCtxPath = join(here, "trace/TraceContext.tsx")
const traceExportPath = join(here, "trace/TraceExportMenu.tsx")
const segmentPath = join(here, "entity-registry/SegmentToggle.tsx")
const reviewTreePath = join(here, "../components/ReviewTree.tsx")
const jsonPath = join(here, "../components/JsonViewer.tsx")
const threadsPath = join(here, "threads/ThreadRunsPanel.tsx")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("widget log chrome — shell", () => {
  it("fills widget-panel from shell — no legacy tile inset on log widgets", () => {
    expect(WIDGET_LOG_INSET_CLASS).toBe("")
    expect(WIDGET_LOG_SHELL_CLASS).not.toContain("pt-3")
    expect(WIDGET_LOG_SHELL_CLASS).toContain("flex-1")
    expect(WIDGET_LOG_STACK_CLASS).toBe(
      `widget-panel-stack ${WIDGET_CONTENT_GUTTER_INNER_CLASS}`,
    )
    expect(WIDGET_LOG_BODY_CLASS).toBe("widget-panel-body")
    expect(WIDGET_LOG_SCROLL_CLASS).toBe("widget-panel-body widget-panel-body--scroll")
    expect(WIDGET_CONTENT_GUTTER_CLASS).toBe("widget-content-gutter")
    expect(WIDGET_CONTENT_GUTTER_INNER_CLASS).toBe("widget-content-gutter-inner")

    const css = read(cssPath)
    expect(css).toMatch(/\.widget-view-container\s*\{[^}]*--widget-content-gutter-inner-y:/s)
    expect(css).toContain(".widget-content-gutter")
    expect(css).toContain(".widget-content-gutter-inner")
    expect(css).toMatch(/\.widget-panel-body--scroll\s*\{[^}]*overflow-y:\s*auto/s)
    expect(css).toMatch(/\.widget-panel\s*\{[^}]*--widget-panel-inset-x:/s)
    expect(css).toContain(".widget-review-controls")
    expect(css).toContain(".widget-review-controls__inset")
    expect(css).toContain(".widget-filter-band")
    expect(css).toMatch(
      /\.widget-review-controls__inset\s*\{[^}]*padding-inline:\s*var\(--review-controls-pad-x\)/s,
    )
    expect(css).toMatch(
      /\.widget-review-controls__inset:not\(:last-child\)\s*\{[^}]*padding-bottom:\s*var\(--review-controls-pad-y\)/s,
    )
    expect(css).toMatch(
      /\.widget-review-controls__inset\s*>\s*\.widget-review-meta\s*\{[^}]*padding:\s*0/s,
    )
    expect(css).toMatch(
      /\.widget-review-controls__inset\s*>\s*\.widget-review-meta\s+\.widget-review-meta__ids\s*\{[^}]*padding-right:\s*0\.4rem/s,
    )

    expect(WIDGET_REVIEW_CONTROLS_CLASS).toBe("widget-review-controls")
    expect(WIDGET_REVIEW_CONTROLS_INSET_CLASS).toBe("widget-review-controls__inset")

    const live = read(livePath)
    const trace = read(traceDagPath)
    const ops = read(opsToolbarPath)
    expect(live).toContain("WIDGET_REVIEW_CONTROLS_CLASS")
    expect(live).toContain("WIDGET_REVIEW_CONTROLS_INSET_CLASS")
    expect(trace).toContain("WIDGET_REVIEW_CONTROLS_CLASS")
    expect(trace).toContain("WIDGET_REVIEW_CONTROLS_INSET_CLASS")
    expect(trace).toContain("WIDGET_LOG_BODY_CLASS")
    // Pipelines split-pane owns its own list scroll; Event Stream keeps the shared host.
    expect(read(opsPath)).toContain("review-split-list-scroll")
    expect(live).toContain("WIDGET_LOG_SCROLL_CLASS")
    expect(read(threadsPath)).toContain("WIDGET_CONTENT_GUTTER_INNER_CLASS")
    expect(read(threadsPath)).toContain("thread-nav-panel")
  })

  it("review widgets mount WidgetToolbar (not freestyle header columns)", () => {
    const live = read(livePath)
    const ops = read(opsToolbarPath)
    const trace = read(traceDagPath)

    expect(live).toContain("WidgetToolbar")
    expect(live).toContain("WidgetToolbarSearch")
    expect(live).toContain("WidgetToolbarTrailing")

    expect(ops).toContain("WidgetToolbar")
    expect(ops).toContain("WidgetToolbarSearch")
    expect(ops).toContain("FilterSheet")
    expect(ops).toContain("FilterChoiceGrid")
    expect(ops).toContain("ReviewTreeFoldToggle")
    expect(ops).toContain("treeFoldMode")
    expect(ops).not.toContain("LOG_TOOLBAR_CHIP")

    expect(trace).toContain("WidgetToolbar")
    expect(trace).toContain("WidgetToolbarSearch")
    expect(trace).toContain("widget-review-meta")
    expect(trace).not.toContain("trace-search")
    expect(trace).not.toContain('className="trace-toolbar')
  })
})

describe("widget log chrome — control height & search", () => {
  it("defines one platform control height and wires toolbar search to it", () => {
    const css = read(cssPath)
    expect(css).toMatch(/--control-h:\s*2\.25rem/)
    expect(css).toMatch(/--wt-control-h:\s*var\(--control-h\)/)
    expect(css).toMatch(
      /\.widget-toolbar__search-wrap\s*\{[^}]*height:\s*var\(--wt-control-h\)/s,
    )
    expect(css).toMatch(
      /\.widget-toolbar__icon-btn\s*\{[^}]*height:\s*var\(--wt-control-h\)/s,
    )
    expect(css).toMatch(
      /\.widget-toolbar__icon-btn\s*\{[^}]*border:\s*1px solid var\(--border\)/s,
    )
    expect(css).toMatch(
      /\.widget-toolbar__chip\s*\{[^}]*height:\s*var\(--wt-control-h\)/s,
    )
  })

  it("Sync search / mode-toggle share CONTROL frame with Event Stream search", () => {
    const css = read(cssPath)
    expect(css).toMatch(
      /\.env-sync-toolbar \.env-sync-search-input\s*\{[^}]*border:\s*1px solid var\(--border\)/s,
    )
    expect(css).toMatch(
      /\.env-sync-toolbar \.env-sync-search-input\s*\{[^}]*background:\s*transparent/s,
    )
    expect(css).toMatch(
      /\.env-sync-toolbar \.env-sync-mode-toggle\s*\{[^}]*border:\s*1px solid var\(--border\)/s,
    )
    expect(css).toMatch(
      /\.env-sync-toolbar \.env-sync-mode-toggle\s*\{[^}]*background:\s*transparent/s,
    )
    expect(css).not.toMatch(
      /\.env-sync-toolbar \.env-sync-search-input\s*\{[^}]*background:\s*var\(--color-base\)/s,
    )
  })

  it("SegmentToggle / SELECT_TRACK share --control-h with search", () => {
    expect(SELECT_TRACK).toContain("control-segment")
    expect(SELECT_TRACK).toContain("h-[var(--control-h)]")
    expect(SELECT_TRACK).toContain("items-stretch")

    const css = read(cssPath)
    expect(css).toMatch(/\.control-segment\s*\{[^}]*height:\s*var\(--control-h\)/s)
    expect(css).toContain(".control-segment__btn")

    const segment = read(segmentPath)
    expect(segment).toContain("control-segment__btn")
    expect(segment).not.toMatch(/py-2 text-sm/)

    const selection = read(selectionPath)
    expect(selection).toContain("h-[var(--control-h)]")
  })

  it("FilterSheet choices keep a visible CONTROL frame — never bare SELECT_*", () => {
    const sheet = read(join(here, "../components/FilterSheet.tsx"))
    expect(sheet).toContain("CONTROL_PRESSED")
    expect(sheet).toContain("CONTROL_IDLE")
    expect(sheet).not.toMatch(/FILTER_CHOICE_ON\s*=\s*SELECT_ACTIVE/)
    expect(sheet).not.toMatch(/FILTER_CHOICE_OFF\s*=\s*SELECT_IDLE/)
    expect(CONTROL_IDLE).toContain("border-border")
    expect(CONTROL_PRESSED).toContain("border-border")
    expect(CONTROL_PRESSED).toContain("bg-[var(--select-fill)]")
  })

  it("FilterSheet places after measuring the mounted panel (short Pipelines sheet)", () => {
    const sheet = read(join(here, "../components/FilterSheet.tsx"))
    // Old bug: ?? 420 with no panel mount → short sheets flip to viewport top.
    expect(sheet).not.toMatch(/\?\?\s*420/)
    expect(sheet).toContain("ResizeObserver")
    expect(sheet).toContain("visibility: pos ? \"visible\" : \"hidden\"")
    expect(sheet).toContain("SHEET_HEIGHT_ESTIMATE")
  })

  it("Trace / Pipelines / Event Stream row hover — rounded wash, not sharp overlay", () => {
    const css = read(cssPath)
    const reviewRow = read(reviewKitPath)
    const live = read(livePath)

    expect(css).toMatch(/\.trace-scope:hover\s*\{[^}]*background:\s*var\(--hover-fill\)/s)
    expect(css).toMatch(
      /\.trace-scope\[data-trace-kind="call"\]:hover\s*\{[^}]*background:\s*var\(--hover-fill\)/s,
    )
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.trace-scope:hover[\s\S]*?background:\s*var\(--hover-fill\)/,
    )
    expect(css).toMatch(/\.review-tree-row__btn:hover\s*\{[^}]*background:\s*var\(--hover-fill\)/s)
    expect(reviewRow).toContain("review-tree-row__btn")
    expect(css).toMatch(/\.log-stream \.event-stream-row:hover\s*\{[^}]*background:\s*var\(--hover-fill\)/s)
    expect(live).toContain("event-stream-row")
    expect(live).not.toContain("hover:bg-overlay-1")
  })

  it("expanded / open / selected rows share select-fill — Event Stream / Trace / Threads / Pipelines", () => {
    const css = read(cssPath)
    const listRow = read(opLogListRowPath)
    const live = read(livePath)

    expect(live).toContain("event-stream-row--open")
    expect(css).toMatch(/\.log-stream \.event-stream-row--open\s*\{[^}]*background:\s*var\(--select-fill\)/s)
    expect(listRow).toContain("ReviewTreeRow")
    expect(css).toMatch(/\.review-tree-row\.is-selected::before\s*\{[^}]*background:\s*var\(--color-accent/s)
    expect(css).toMatch(
      /\.review-operator \.review-tree-row\.is-selected\s*>\s*\.review-tree-row__btn[\s\S]*?background:\s*var\(--select-fill/s,
    )
    expect(css).toMatch(
      /\.trace-tree-row\.is-selected\s*>\s*\.trace-tree-row__btn[\s\S]*?background:\s*var\(--select-fill/s,
    )
    // Parent wash must not override selected fill (light theme specificity trap).
    expect(css).toContain(".review-tree-row.is-branch:not(.is-selected)")
    expect(css).toContain(".trace-tree-row.is-branch:not(.is-selected)")
    expect(css).toMatch(
      /\.trace-card\.is-open\s*>\s*\.trace-scope\s*\{[^}]*background:\s*var\(--select-fill\)/s,
    )
    expect(css).toMatch(
      /\.trace-scope\.is-soft\.is-open\s*\{[^}]*background:\s*var\(--select-fill\)/s,
    )
    expect(css).toMatch(
      /\.thread-nav-thread--expanded\s*>\s*\.thread-nav-thread-row\s*\{[^}]*background:\s*var\(--select-fill\)/s,
    )
    // Light open must not collapse to transparent idle.
    expect(css).toMatch(
      /:root\[data-theme="light"\][\s\S]*?\.trace-card\.is-open\s*>\s*\.trace-scope[\s\S]*?background:\s*var\(--select-fill\)/,
    )
  })

  it("toolbar icon badges are one ink/paper pill — theme-responsive, not error-red", () => {
    const css = read(cssPath)
    const live = read(livePath)

    expect(css).toContain(".widget-toolbar__icon-badge")
    expect(css).toMatch(/\.widget-toolbar__icon-badge\s*\{[^}]*border-radius:\s*9999px/s)
    expect(css).toMatch(/\.widget-toolbar__icon-badge\s*\{[^}]*background:\s*var\(--text\)/s)
    expect(css).toMatch(/\.widget-toolbar__icon-badge\s*\{[^}]*color:\s*var\(--bg\)/s)
    expect(css).toMatch(/\.widget-toolbar__icon-badge\s*\{[^}]*font-weight:\s*700/s)
    expect(css).toMatch(
      /\.widget-toolbar__icon-badge--pending\s*\{[^}]*background:\s*var\(--text\)/s,
    )
    expect(css).toMatch(
      /\.widget-toolbar__icon-badge--pending\s*\{[^}]*color:\s*var\(--bg\)/s,
    )
    expect(css).not.toMatch(
      /\.widget-toolbar__icon-badge(?:--pending)?\s*\{[^}]*background:\s*var\(--error\)/s,
    )
    expect(css).not.toMatch(
      /\.widget-toolbar__icon-badge\s*\{[^}]*color:\s*var\(--text-on-accent/s,
    )
    expect(css).toMatch(
      /\.widget-toolbar__trailing\s*\{[^}]*padding-right:\s*0\.4rem/s,
    )
    expect(live).toContain("widget-toolbar__icon-badge")
    expect(live).not.toContain("widget-toolbar__icon-badge--pending")
    expect(live).not.toMatch(/-top-1\.5|-right-1\.5/)
    const opsToolbar = read(opsToolbarPath)
    expect(opsToolbar).toContain("widget-toolbar__icon-badge")
    expect(opsToolbar).not.toMatch(/bg-text.*text-text-on-accent|text-text-on-accent.*bg-text/)
    expect(opsToolbar).not.toMatch(/-top-0\.5|-right-0\.5/)
  })

  it("search is first to yield; narrow toolbar stacks so trailing cannot overlap", () => {
    const css = read(cssPath)
    expect(css).toContain("container-name: widget-toolbar")
    expect(css).toContain("container-type: inline-size")
    expect(css).toMatch(
      /\.widget-toolbar__search\s*\{[^}]*min-width:\s*6\.5rem/s,
    )
    expect(css).toMatch(
      /@container widget-toolbar \(max-width: 36rem\)\s*\{[^}]*grid-template-areas:[\s\S]*?"search"[\s\S]*?"trailing"/s,
    )
    expect(css).toContain(".widget-toolbar__leading:empty")
  })

  it("toolbar search / filter / export icons are 14px", () => {
    const toolbar = read(toolbarPath)
    expect(toolbar).toMatch(/Search size=\{14\}/)
    expect(toolbar).toMatch(/X size=\{14\}/)
    expect(toolbar).toMatch(/Loader2 size=\{14\}/)

    const live = read(livePath)
    const ops = read(opsToolbarPath)
    const exportMenu = read(traceExportPath)
    expect(live).toMatch(/SlidersHorizontal size=\{14\}/)
    expect(ops).toMatch(/SlidersHorizontal size=\{14\}/)
    expect(exportMenu).toMatch(/Download size=\{14\}/)
    expect(exportMenu).not.toMatch(/Download size=\{16\}/)
  })
})

describe("widget log chrome — curved nest geometry", () => {
  it("chevron slot width is 2× stem-x (stem under chevron center)", () => {
    const css = read(cssPath)
    expect(css).toContain("--review-tree-x:")
    expect(css).toMatch(
      /--review-chevron-slot:\s*calc\(var\(--review-tree-x\)\s*\*\s*2\)/,
    )
    expect(css).toMatch(
      /\.review-chevron-slot\s*\{[^}]*width:\s*var\(--review-chevron-slot\)/s,
    )
    expect(css).toMatch(
      /\.thread-nav-chevron\s*\{[^}]*width:\s*var\(--review-chevron-slot\)/s,
    )
    expect(css).toMatch(
      /\.trace-scope__chevslot\s*\{[^}]*width:\s*var\(--review-chevron-slot\)/s,
    )
  })

  it("Event Stream / Pipelines / Threads use the shared chevron slot", () => {
    const live = read(livePath)
    const listRow = read(opLogListRowPath)
    const ops = read(opsPath)
    const threads = read(threadsPath)

    expect(live).toContain("review-chevron-slot")
    expect(listRow).toContain("ReviewTreeRow")
    expect(ops).toContain("ReviewSplitPane")
    expect(threads).toContain("thread-nav-chevron")
    expect(threads).toMatch(/ChevronRight size=\{13\}/)
  })

  it("nests stay flush — no second pl-* before ReviewTree (stem under first letter)", () => {
    const live = read(livePath)
    const foundation = read(reviewTreePath)

    expect(live).not.toMatch(/pl-3[\s\S]{0,40}review-tree/)
    expect(foundation).toContain("Nest flush with the parent row")
    expect(foundation).toContain("review-chevron-slot")
  })

  it("Pipelines detail uses review kit accordions — no legacy inline timeline", () => {
    const ops = read(opsPath)
    const scope = read(join(here, "pipelines/OperationLogScopeDetail.tsx"))
    const inspector = read(join(here, "pipelines/OperationLogInspector.tsx"))

    expect(ops).not.toContain("OperationLogPipelineTimeline")
    expect(ops).not.toContain("OpLogRow")
    expect(ops).not.toContain("LogNest")
    expect(scope).toContain("ReviewDetailAccordion")
    expect(scope).toContain("ReviewPayloadBlock")
    expect(inspector).toContain("ReviewDetailPane")
  })

  it("elbow CSS stays on direct ReviewTreeItem children only", () => {
    const css = read(cssPath)
    expect(css).toContain(".review-tree > .review-tree__item::before")
    expect(css).toContain(".review-tree > .review-tree__item:not(:last-child)::after")
    expect(css).toContain("border-bottom-left-radius: var(--review-tree-radius)")
    expect(css).toContain("--review-tree-line")
    // Shared nest ink must stay visible on dark chat/Threads — never raw zinc-800.
    expect(css).toMatch(
      /:root\s*\{[^}]*--review-tree-line:\s*color-mix\(in srgb,\s*var\(--border\) 70%,\s*var\(--text-faint\)\)/s,
    )
    expect(css).not.toMatch(/:root\s*\{[^}]*--review-tree-line:\s*#27272a/s)
    expect(css).toContain("--review-tree-radius")

    const foundation = read(reviewTreePath)
    expect(foundation).toContain("Only *direct* ReviewTreeItem children")
    expect(foundation).toContain("never as a peer of that item")
  })

  it("Trace nest stays Threads-model: no in-flow depth pads, no gutter full-bleed", () => {
    const css = read(cssPath)
    const rows = read(join(here, "trace/TraceRows.tsx"))
    // Retired — compounded with ReviewTree and drifted Call/Sent.
    expect(css).not.toMatch(
      /^\.trace-scope\[data-trace-depth="1"\]\s*\{[^}]*padding-left:\s*1\.1rem/m,
    )
    // Full-bleed into gutter zig-zags stems — must stay gone.
    expect(css).not.toContain("Chevron-on-stem")
    expect(css).not.toMatch(
      /\.trace-dag \.review-tree > \.review-tree__item > \.trace-card[\s\S]{0,80}margin-left:\s*calc\(0px - var\(--review-tree-gutter\)\)/s,
    )
    expect(css).toContain("never full-bleed into the gutter")
    // Tool defs reserve the chevron column so elbows don’t kiss names.
    expect(rows).toMatch(/trace-ctx-item__head[\s\S]*review-chevron-slot/)
    // Pin stack still owns stepped indent for sticky clones.
    expect(css).toContain('.trace-pin__stack > .trace-scope[data-trace-depth="1"]')
  })

  it("JsonViewer never grows its own review-tree elbows", () => {
    const json = read(jsonPath)
    expect(json).toContain("mia-code-block__label")
    expect(json).not.toContain("review-tree")
  })
})

describe("widget log chrome — Trace meta & scope payload", () => {
  it("meta band spaces stats — numbers weighty, no middot soup", () => {
    const css = read(cssPath)
    const dag = read(traceDagPath)

    // Band chrome shared with Pipelines ActiveFilterChips.
    expect(css).toMatch(/\.widget-filter-band\s*\{[^}]*display:\s*flex/s)
    expect(css).toMatch(/\.widget-filter-band\s*\{[^}]*gap:/s)
    expect(dag).toContain("widget-filter-band widget-review-meta")
    expect(css).toContain(".widget-review-meta__stat-value")
    expect(css).toMatch(
      /\.widget-review-meta__stat-value\s*\{[^}]*font-weight:\s*600/s,
    )
    expect(css).toContain(".widget-review-meta__id-group")
    expect(css).toContain(".widget-review-meta__ids")

    expect(dag).toContain("widget-review-meta__stats")
    expect(dag).toContain("widget-review-meta__ids")
    expect(dag).toContain("widget-review-meta__stat-value")
    expect(dag).toContain('tone="meta"')
    expect(dag).not.toMatch(/metaParts\.join\(" · "\)/)
    expect(dag).not.toMatch(/widget-review-meta[\s\S]{0,400}" · "/)
  })

  it("Trace seams earn their keep — no striped chrome / open-header rules", () => {
    const css = read(cssPath)
    // Meta rides .widget-filter-band — same hairline-free strip as filter chips.
    expect(css).toMatch(
      /\.widget-filter-band\s*\{[^}]*border-bottom:\s*none/s,
    )
    // Flat list dialect both themes — no hairlines under outline headers.
    expect(css).toMatch(
      /\.trace-card\.is-open\s*>\s*\.trace-scope\s*\{[^}]*border-bottom:\s*none/s,
    )
    expect(css).toMatch(
      /\.trace-card:not\(\.is-open\)\s*>\s*\.trace-scope\s*\{[^}]*border-bottom:\s*none/s,
    )
    // Sticky pin: one underline under the whole block (Cursor dialect) — not per-row hairlines.
    expect(css).toMatch(
      /\.trace-pin__stack\s*\{[^}]*border-bottom:\s*1px solid/s,
    )
    // Toolbar still closes the control band.
    expect(css).toMatch(
      /\.widget-toolbar\s*\{[^}]*border-bottom:\s*1px solid/s,
    )
  })

  it("Prompt / Received / phase sections use trace-scope-payload (label column, not peer gutter)", () => {
    const css = read(cssPath)
    const ctx = read(traceCtxPath)
    const call = read(traceCallPath)
    const phase = read(join(here, "trace/TracePhase.tsx"))

    expect(css).toContain(".trace-scope-payload")
    expect(css).toMatch(
      /\.trace-scope-payload\s*\{[^}]*padding:[^;]*var\(--review-chevron-slot\)/s,
    )
    expect(css).toContain(".trace-scope-payload.trace-phase-body")
    expect(css).toContain(".trace-spine-gap")

    expect(ctx).toContain("trace-scope-payload")
    expect(ctx).not.toMatch(/review-branch-pad[\s\S]{0,40}systemPrompt/)
    expect(call).toContain("trace-scope-payload")
    expect(call).not.toMatch(
      /receivedOpen && \([\s\S]*?review-branch-pad trace-branch__content/,
    )
    // TIMELINE/RAW under Subagent — same lead column as SUBAGENT (not tree gutter).
    expect(phase).toContain("trace-scope-payload trace-phase-body")
    expect(phase).not.toContain("trace-scope-body trace-phase-body")
    expect(phase).toContain("trace-phase-nested review-tree")
  })

  it("Call outline still nests messages under Sent via ReviewTree", () => {
    const call = read(traceCallPath)
    expect(call).toContain("ReviewTree")
    expect(call).toContain("ReviewTreeItem")
    expect(call).toMatch(/sentOpen[\s\S]*ReviewTree[\s\S]*PromptMessageRow/)
  })
})

describe("widget log chrome — shared content dialect", () => {
  it("shares meta size, JsonViewer, and review-tree across review widgets", () => {
    const css = read(cssPath)
    const live = read(livePath)
    const ops = read(opsPath)
    const nest = read(nestPath)
    const call = read(traceCallPath)

    expect(css).toContain("--review-meta-size")
    expect(css).toContain("font-size: var(--review-meta-size)")

    expect(live).toContain("review-meta")
    expect(live).toContain("JsonViewer")
    expect(live).not.toContain("border-l-2")

    const scope = read(join(here, "pipelines/OperationLogScopeDetail.tsx"))
    expect(scope).toContain("ReviewPayloadBlock")
    expect(nest).not.toContain("CodeBlock")
    expect(call).toContain("ReviewTree")
    expect(call).toContain("ReviewTreeItem")
  })

  it("day / section caps use shared review-group-size — quieter than list body", () => {
    const css = read(cssPath)
    const ops = read(opsPath)
    const sheet = read(join(here, "../components/FilterSheet.tsx"))

    expect(css).toMatch(/--review-group-size:\s*0\.6875rem/)
    expect(css).toMatch(
      /\.review-group-label\s*\{[^}]*font-size:\s*var\(--review-group-size\)/s,
    )
    expect(ops).toContain("review-group-label")
    expect(ops).toMatch(
      /const DAY_GROUP_BTN\s*=\s*\n?\s*"review-group-label review-group-cap[^"]*"/,
    )
    expect(ops).not.toMatch(/const DAY_GROUP_BTN[\s\S]{0,200}text-sm/)
    expect(ops).not.toMatch(/DAY_GROUP_BTN[\s\S]{0,280}bg-surface/)
    expect(ops).not.toMatch(/DAY_GROUP_BTN[\s\S]{0,280}backdrop-blur/)
    expect(sheet).toContain("review-group-label")
  })

  it("sticky section caps use flat --section-cap-bg (both themes)", () => {
    const css = read(cssPath)
    expect(css).toContain("--section-cap-bg")
    expect(css).not.toMatch(/--section-cap-bg:\s*color-mix/)
    expect(css).toMatch(
      /\.review-group-cap\s*\{[^}]*background:\s*var\(--section-cap-bg\)/s,
    )
    expect(css).toMatch(
      /:root\[data-theme="light"\][^{]*\{[^}]*--section-cap-bg:\s*var\(--workspace-widget-bg,\s*var\(--panel\)\)/s,
    )
    expect(css).toMatch(
      /\.entity-rail-group__header\s*\{[^}]*background:\s*var\(--section-cap-bg\)/s,
    )
  })

  it("day groups use sticky section dividers aligned to the table", () => {
    const ops = read(opsPath)
    const css = read(cssPath)
    expect(ops).toContain("op-log-day-cap")
    expect(ops).toContain("review-group-cap__count")
    expect(ops).not.toContain("dayCardClass")
    expect(ops).not.toContain("op-log-day-card")
    expect(css).toContain(".op-log-day-cap")
    expect(css).not.toContain(".op-log-day-card")
  })

  it("Pipelines tree uses review kit grid, day grouping caps, and split shell", () => {
    const css = read(cssPath)
    const listRow = read(opLogListRowPath)
    const ops = read(opsPath)
    const scope = read(join(here, "pipelines/OperationLogScopeDetail.tsx"))

    expect(css).toContain(".review-tree-row")
    expect(css).toContain(".op-log-day-cap")
    expect(css).toContain(".op-log-entity-icon")
    expect(css).toContain(".op-log-status-pill")
    expect(css).toContain(".review-detail")
    expect(css).toContain(".review-detail-section--accordion")
    expect(listRow).toContain("ReviewTreeRow")
    expect(listRow).toContain("formatPipelineSubtitle")
    expect(listRow).toContain("onToggleFold")
    expect(ops).toContain("ReviewSplitPane")
    expect(ops).not.toContain("ReviewTreeHeader")
    expect(ops).toContain("op-log-day-cap")
    expect(ops).toContain("review-split-body")
    expect(ops).toContain("OperationLogInspector")
    expect(ops).toContain("OperationLogPipelineListRow")
    expect(ops).toContain("selectPipeline")
    expect(ops).toContain("selectActivity")
    expect(ops).toContain("OperationLogScopeDetail")
    expect(ops).toContain("openPipelineIds")
    expect(css).toContain(".op-log-pipeline-list-row")
    expect(css).toContain(".op-log-activity-tree-row")
    expect(css).toMatch(
      /\.review-operator \.review-split-list\s*\{[^}]*--review-tree-base-pad:\s*16px/s,
    )
    expect(css).toContain("scrollbar-gutter: stable")
    expect(css).toContain(".review-split-list-scroll")
    expect(ops).toContain("pipelineEventKey")
    expect(css).toContain(".op-log-pipeline-list-row.is-selected")
    expect(scope).toContain("ReviewDetailAccordion")
    expect(ops).not.toContain("LogStatusLabel")
    expect(ops).not.toContain("StatusMessage")
    expect(ops).not.toContain("STATUS_MESSAGE_BOX")
  })
})

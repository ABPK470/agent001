/**
 * Widget log scroll — regression contracts (review-family shell).
 *
 * First principles:
 *   shell  → flex column, overflow hidden (bounds height)
 *   stack  → flex 1, min-h-0, overflow hidden (passes bound to body)
 *   body   → flex 1, min-h-0, overflow hidden (Trace: inner panes scroll)
 *   scroll → body + --scroll modifier, overflow-y: auto in source CSS
 *
 * VirtualList scrollRef must attach to the scroll host, not the body slot.
 * Never use Tailwind overflow-y-auto on widget-panel-body — the utility is
 * emitted before custom CSS in the bundle and loses to overflow: hidden.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  WIDGET_LOG_BODY_CLASS,
  WIDGET_LOG_SCROLL_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
} from "./widget-toolbar"

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, "../boot/index.css")
const distAssetsPath = join(here, "../dist/assets")
const livePath = join(here, "LiveLogs.tsx")
const opsPath = join(here, "OperationLog.tsx")
const tracePath = join(here, "trace/TraceDag.tsx")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

function panelBodyBlock(css: string): string {
  const match = css.match(/\.widget-panel-body\s*\{[^}]*\}/s)
  expect(match).toBeTruthy()
  return match![0]
}

function panelBodyScrollBlock(css: string): string {
  const match = css.match(/\.widget-panel-body--scroll\s*\{[^}]*\}/s)
  expect(match).toBeTruthy()
  return match![0]
}

describe("widget log scroll — CSS contracts", () => {
  const css = read(cssPath)

  it("shell + stack clip; body slot clips; --scroll modifier scrolls vertically", () => {
    expect(WIDGET_LOG_SHELL_CLASS).toMatch(/overflow-hidden/)
    expect(WIDGET_LOG_STACK_CLASS).toContain("widget-panel-stack")

    expect(css).toMatch(/\.widget-panel-stack\s*\{[^}]*overflow:\s*hidden/s)
    expect(panelBodyBlock(css)).toMatch(/overflow:\s*hidden/)
    expect(panelBodyScrollBlock(css)).toMatch(/overflow-y:\s*auto/)
    expect(panelBodyScrollBlock(css)).toMatch(/overflow-x:\s*hidden/)
  })

  it("scroll modifier follows base body rule in source (cascade override)", () => {
    const bodyIdx = css.indexOf(".widget-panel-body {")
    const scrollIdx = css.indexOf(".widget-panel-body--scroll {")
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(scrollIdx).toBeGreaterThan(bodyIdx)
  })

  it("WIDGET_LOG_SCROLL_CLASS pairs body slot with scroll modifier", () => {
    expect(WIDGET_LOG_SCROLL_CLASS).toBe(
      `${WIDGET_LOG_BODY_CLASS} widget-panel-body--scroll`,
    )
  })
})

describe("widget log scroll — review-family wiring", () => {
  const live = read(livePath)
  const ops = read(opsPath)
  const trace = read(tracePath)

  it("virtualized list widgets bind scrollRef to the scroll host", () => {
    // Event Stream: dedicated block scrollport (flex body leaked abspos rows into the deck).
    expect(live).toMatch(/ref=\{containerRef\}[\s\S]{0,160}event-stream-feed__scroll/)
    expect(live).toContain("scrollRef={containerRef}")
    expect(live).not.toContain("WIDGET_LOG_SCROLL_CLASS")
    expect(read(cssPath)).toMatch(
      /\.event-stream-feed__scroll\s*\{[^}]*display:\s*block/s,
    )
    expect(read(cssPath)).toMatch(
      /\.event-stream-feed__scroll\s*\{[^}]*overflow-y:\s*auto/s,
    )
    // Pipelines: split-pane owns list scroll (CSS .review-split-list-scroll).
    expect(ops).toMatch(/ref=\{listScrollRef\}[\s\S]{0,160}review-split-list-scroll/)
    expect(ops).not.toContain("WIDGET_LOG_SCROLL_CLASS")
    expect(read(cssPath)).toMatch(/\.review-split-list-scroll\s*\{[^}]*overflow-y:\s*auto/s)
  })

  it("trace uses body slot on split shell; tree scroller is inner CSS", () => {
    expect(trace).toContain("WIDGET_LOG_BODY_CLASS")
    expect(trace).not.toContain("WIDGET_LOG_SCROLL_CLASS")
    expect(read(cssPath)).toMatch(/\.trace-split-tree-scroll\s*\{[^}]*overflow-y:\s*auto/s)
  })

  it("forbids fragile widget-panel-body + Tailwind overflow-y-auto on review lists", () => {
    for (const [label, src] of [
      ["OperationLog", ops],
      ["LiveLogs", live],
    ] as const) {
      expect(src, label).not.toMatch(/widget-panel-body[\s\S]{0,100}overflow-y-auto/)
      expect(src, label).not.toMatch(/WIDGET_LOG_BODY_CLASS[\s\S]{0,100}overflow-y-auto/)
      expect(src, label).not.toContain("overflow-y-auto")
    }
  })

  it("OperationLog passes scrollRef into VirtualList", () => {
    expect(ops).toMatch(/scrollRef=\{listScrollRef\}/)
    expect(ops).toContain("VirtualList")
  })

  it("LiveLogs passes containerRef into VirtualList", () => {
    expect(live).toMatch(/scrollRef=\{containerRef\}/)
    expect(live).toContain("VirtualList")
  })
})

function readBuiltCss(): string | null {
  if (!existsSync(distAssetsPath)) return null
  const file = readdirSync(distAssetsPath).find((name) => name.endsWith(".css"))
  if (!file) return null
  return read(join(distAssetsPath, file))
}

describe("widget log scroll — production bundle", () => {
  it("built CSS keeps scroll modifier after base panel-body", () => {
    const bundle = readBuiltCss()
    if (!bundle) return

    const bodyIdx = bundle.indexOf(".widget-panel-body{")
    const scrollIdx = bundle.indexOf(".widget-panel-body--scroll{")
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(scrollIdx).toBeGreaterThan(bodyIdx)
    expect(bundle.slice(scrollIdx, scrollIdx + 80)).toMatch(/overflow-y:auto|overflow:hidden auto/)
  })
})

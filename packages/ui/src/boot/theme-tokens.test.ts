/**
 * Light theme: elevated surfaces (canvas → white panel → inset),
 * semantic status chroma, brand purple accent.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, "../boot/index.css"), "utf8")

function lightThemeBlock(): string {
  const match = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)
  expect(match?.[1]).toBeTruthy()
  return match![1]!
}

function darkThemeBlock(): string {
  const match = css.match(/:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)
  expect(match?.[1]).toBeTruthy()
  return match![1]!
}

describe("light theme color system", () => {
  it("restores brand purple accent (not ink)", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--accent:\s*#7B6FC7/)
    expect(block).not.toMatch(/--accent:\s*var\(--ink\)/)
    expect(block).toMatch(/--logo-mark-live:\s*var\(--accent\)/)
    expect(block).toMatch(/--logo-mark-idle:\s*var\(--ink\)/)
    expect(block).toMatch(/--viewing-as:\s*var\(--accent\)/)
  })

  it("uses three-step surface elevation (not flat paper everywhere)", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--canvas:\s*#f4f4f6/)
    expect(block).toMatch(/--panel:\s*#ffffff/)
    expect(block).toMatch(/--panel-2:\s*#f8fafc/)
    expect(block).toMatch(/--panel-3:\s*#f1f5f9/)
    expect(block).not.toMatch(/--panel:\s*var\(--paper\)/)
    expect(block).not.toMatch(/--panel-2:\s*var\(--paper\)/)
  })

  it("maps status tokens to semantic chroma (not ink-only)", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--success:\s*#166534/)
    expect(block).toMatch(/--error:\s*#991b1b/)
    expect(block).toMatch(/--warning:\s*#9a3412/)
    expect(block).toMatch(/--info:\s*#1e40af/)
    expect(block).toMatch(/--success-soft:\s*#dcfce7/)
    expect(block).toMatch(/--error-soft:\s*#fee2e2/)
    expect(block).not.toMatch(/--success:\s*var\(--ink\)/)
    expect(block).not.toMatch(/--error:\s*var\(--ink\)/)
  })

  it("tree status dots use theme-split chroma (muted light / bright dark)", () => {
    const light = lightThemeBlock()
    const dark = darkThemeBlock()
    expect(light).toMatch(/--status-dot-ok:\s*#059669/)
    expect(light).toMatch(/--status-dot-err:\s*#e11d48/)
    expect(dark).toMatch(/--status-dot-ok:\s*#34d399/)
    expect(dark).toMatch(/--status-dot-err:\s*#fb7185/)
    expect(css).toMatch(
      /\.op-log-status-dot\.is-ok\s*\{[^}]*background:\s*var\(--status-dot-ok\)/s,
    )
    expect(css).toMatch(
      /\.op-log-status-dot\.is-err\s*\{[^}]*background:\s*var\(--status-dot-err\)/s,
    )
    expect(css).toContain(".review-tree-guide.is-branch")
    expect(css).toContain(".review-tree-guide.is-corner")
  })

  it("maps datatype tokens to subtle syntax hues", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--dt-string:\s*#6d28d9/)
    expect(block).toMatch(/--dt-int:\s*#1d4ed8/)
    expect(block).not.toMatch(/--dt-string:\s*var\(--ink\)/)
  })

  it("select/hover fills use explicit slate on white panel", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--hover-fill:\s*#f1f5f9/)
    expect(block).toMatch(/--select-fill:\s*#e2e8f0/)
    expect(block).toMatch(/--overlay-1:\s*#f8fafc/)
    expect(block).toMatch(/--overlay-hover:\s*var\(--hover-fill\)/)
  })

  it("diff panes use inset panel-2 sheet", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--diff-surface:\s*var\(--panel-2\)/)
    expect(block).toMatch(/--diff-add:\s*#15803d/)
    expect(block).toMatch(/--diff-del:\s*#b91c1c/)
    const src = readFileSync(join(here, "../widgets/platform/CatalogJsonDiff.tsx"), "utf8")
    expect(src).toContain("bg-diff-surface")
    expect(src).toContain("text-diff-add")
    expect(src).toContain("text-diff-del")
  })

  it("policy effects derive from status chroma", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--policy-allow:\s*var\(--success\)/)
    expect(block).toMatch(/--policy-deny:\s*var\(--error\)/)
    expect(block).not.toMatch(/--policy-allow:\s*var\(--ink\)/)
    const schema = readFileSync(join(here, "../widgets/platform/policy/selector-schema.ts"), "utf8")
    expect(schema).toContain("policyEffectPillClass")
    expect(schema).toContain("mia-status-pill--fixed")
    const rulesTab = readFileSync(join(here, "../widgets/platform/policy/SelectorRulesTab.tsx"), "utf8")
    expect(rulesTab).toContain("policyEffectPillClass(rule.effect, true)")
    expect(rulesTab).not.toContain("border-l-[3px]")
    const policy = readFileSync(join(here, "../widgets/platform/PolicyEditor.tsx"), "utf8")
    expect(policy).toContain("grid-cols-[240px_minmax(0,1fr)_220px]")
    expect(policy).toContain("policyEffectPillClass")
  })

  it("status callouts are theme-split (light chroma wash + pills; dark left stroke)", () => {
    const light = lightThemeBlock()
    const dark = darkThemeBlock()
    expect(light).toMatch(/--status-callout-err-soft:\s*var\(--error-soft\)/)
    expect(light).toMatch(/--status-callout-ok-soft:\s*var\(--success-soft\)/)
    expect(light).toMatch(/--error-surface:\s*#fef2f2/)
    expect(light).toMatch(/--success-surface:\s*#f0fdf4/)
    expect(dark).toMatch(/--status-callout-err-soft:\s*var\(--overlay-2\)/)
    expect(dark).toMatch(/--status-callout-ok-soft:\s*var\(--overlay-2\)/)
    expect(css).toMatch(/\.mia-status-pill--err\b/)
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.mia-callout--err[\s\S]*background:\s*var\(--error-soft\)/,
    )
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.mia-callout--err[\s\S]*border-left:\s*3px\s+solid\s+var\(--error\)/,
    )
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.termchat-transcript-shell \.chat-tool-error[\s\S]*border-left:\s*3px\s+solid\s+var\(--error\)/,
    )
    expect(css).toMatch(/\.log-stream \.event-stream-row:hover/)
    expect(css).toMatch(/\.event-stream-payload__box--err/)
    expect(css).toMatch(
      /\.event-stream-payload__box--err\s*\{[^}]*border-left-color:\s*var\(--error\)/s,
    )
    // Inline expand (no drawer room) — flat rectangle, not a rounded card.
    expect(css).toMatch(
      /\.event-stream-payload__box\s*\{[^}]*border-radius:\s*0/s,
    )
    expect(css).toMatch(
      /\.event-stream-payload__box\s*\{[^}]*box-shadow:\s*none/s,
    )
    // Event Stream scan lanes — TYPE ink in both themes.
    for (const lane of ["run", "step", "sync", "bridge", "agent", "api", "system"]) {
      expect(darkThemeBlock()).toMatch(new RegExp(`--stream-${lane}-ink:`))
      expect(lightThemeBlock()).toMatch(new RegExp(`--stream-${lane}-ink:`))
      expect(css).toMatch(new RegExp(`\\.event-stream-type--${lane}\\s*\\{`))
      expect(css).toMatch(new RegExp(`\\.event-stream-filter-type--${lane}\\s*\\{`))
    }
    // Dual-mode badge tokens — agent emerald (never error-red / dt-bool rose).
    expect(lightThemeBlock()).toMatch(/--stream-step-soft:\s*#f3e8ff/i)
    expect(lightThemeBlock()).toMatch(/--stream-step-border:\s*#e9d5ff/i)
    expect(css).toMatch(/\.event-stream-type--agent\b/)
    expect(css).toMatch(/\.event-stream-filter-type--agent\b/)
    expect(css).toMatch(
      /\.filter-choice-btn\.event-stream-filter-type\s*\{[^}]*min-width:\s*0/s,
    )
    expect(css).toMatch(/\.event-stream-row\s*\{[^}]*grid-template-columns:/s)
    expect(css).toMatch(/\.event-stream-row__time\s*\{[^}]*font-family:\s*var\(--font-mono/s)
    expect(css).toMatch(/\.event-stream-jump\s*\{[^}]*position:\s*sticky/s)
    // Lane spread: run blue · step violet · sync magenta · bridge cyan ·
    // agent green · api teal · system zinc.
    expect(lightThemeBlock()).toMatch(/--stream-run-ink:\s*#2563eb/i)
    expect(lightThemeBlock()).toMatch(/--stream-step-ink:\s*#9333ea/i)
    expect(lightThemeBlock()).toMatch(/--stream-sync-ink:\s*#db2777/i)
    expect(lightThemeBlock()).toMatch(/--stream-bridge-ink:\s*#0891b2/i)
    expect(lightThemeBlock()).toMatch(/--stream-agent-ink:\s*#16a34a/i)
    expect(lightThemeBlock()).toMatch(/--stream-api-ink:\s*#0f766e/i)
    expect(lightThemeBlock()).toMatch(/--stream-system-ink:\s*#52525b/i)
    expect(darkThemeBlock()).toMatch(/--stream-run-ink:\s*#60a5fa/i)
    expect(darkThemeBlock()).toMatch(/--stream-step-ink:\s*#c084fc/i)
    expect(darkThemeBlock()).toMatch(/--stream-sync-ink:\s*#f472b6/i)
    expect(darkThemeBlock()).toMatch(/--stream-bridge-ink:\s*#22d3ee/i)
    expect(darkThemeBlock()).toMatch(/--stream-agent-ink:\s*#4ade80/i)
    expect(darkThemeBlock()).toMatch(/--stream-api-ink:\s*#2dd4bf/i)
    expect(darkThemeBlock()).toMatch(/--stream-system-ink:\s*#a1a1aa/i)
    // Run is royal blue; API is teal — not swapped / not wheat.
    expect(lightThemeBlock()).not.toMatch(/--stream-api-ink:\s*#(2563eb|a16207|b45309)/i)
    expect(darkThemeBlock()).not.toMatch(/--stream-api-ink:\s*#(60a5fa|f8ed81|fbbf24)/i)
    expect(darkThemeBlock()).not.toMatch(/--stream-sync-ink:\s*#(fb923c|f97316)/i)
    expect(lightThemeBlock()).not.toMatch(/--stream-sync-ink:\s*#(c2410c|ea580c)/i)
    // System must not share run’s blue-slate cast in the histogram.
    expect(darkThemeBlock()).not.toMatch(/--stream-system-ink:\s*#(94a3b8|64748b|cbd5e1)/i)
    expect(lightThemeBlock()).not.toMatch(/--stream-system-ink:\s*#(334155|1e293b)/i)
    // Agent must not collide with severity red.
    expect(lightThemeBlock()).not.toMatch(/--stream-agent-ink:\s*#(be123c|991b1b|b91c1c)/i)
    expect(darkThemeBlock()).not.toMatch(/--stream-agent-ink:\s*#(fda4af|f87171|fb7185)/i)
    const liveLogs = readFileSync(join(here, "../widgets/LiveLogs.tsx"), "utf8")
    expect(liveLogs).not.toContain("mia-row-stroke")
    expect(liveLogs).toContain("event-stream-row")
    expect(liveLogs).toContain("eventStreamTypeClass")
    expect(css).toMatch(/\.mia-code-block\s*\{[^}]*background:\s*transparent/s)
    expect(css).toMatch(/:root\[data-theme="light"\] \.mia-code-block[\s\S]*background:\s*var\(--panel-2\)/)
    const policy = readFileSync(join(here, "../widgets/platform/PolicyEditor.tsx"), "utf8")
    expect(policy).toContain("grid-cols-[240px_minmax(0,1fr)_220px]")
  })

  it("dark status pills use tinted fills + semantic ink; callout softs stay quiet", () => {
    const dark = darkThemeBlock()
    // Callout boxes remain Factory Reset quiet.
    expect(dark).toMatch(/--status-callout-ok-soft:\s*var\(--overlay-2\)/)
    expect(dark).toMatch(/--status-callout-err-soft:\s*var\(--overlay-2\)/)
    // Pills are scan anchors — tint fill (FAIL hotter than OK).
    expect(dark).toMatch(
      /--status-pill-ok-soft:\s*color-mix\(in srgb,\s*var\(--success\) 12%,\s*transparent\)/,
    )
    expect(dark).toMatch(
      /--status-pill-err-soft:\s*color-mix\(in srgb,\s*var\(--error\) 15%,\s*transparent\)/,
    )
    expect(dark).toMatch(
      /--status-pill-err-border:\s*color-mix\(in srgb,\s*var\(--error\) 30%,\s*transparent\)/,
    )
    expect(dark).toMatch(
      /--status-pill-ok-border:\s*color-mix\(in srgb,\s*var\(--success\) 22%,\s*transparent\)/,
    )
    expect(dark).toMatch(
      /--status-pill-info-soft:\s*color-mix\(in srgb,\s*var\(--info\) 12%,\s*transparent\)/,
    )
    expect(css).toMatch(
      /\.mia-status-pill--ok\s*\{[^}]*background:\s*var\(--status-pill-ok-soft\)[^}]*color:\s*var\(--success\)/s,
    )
    expect(css).toMatch(
      /\.mia-status-pill--err\s*\{[^}]*background:\s*var\(--status-pill-err-soft\)[^}]*color:\s*var\(--error\)/s,
    )
    expect(css).toMatch(/\.mia-status-pill--info\s*\{[^}]*color:\s*var\(--info\)/s)
    expect(css).toContain(".mia-status-pill--skip")
    expect(css).toContain(".mia-status-pill--muted")
    // Pill rules must not fall back to muted zinc ink on dark.
    expect(css).not.toMatch(/\.mia-status-pill--ok\s*\{[^}]*color:\s*var\(--text-muted/s)
    expect(css).not.toMatch(/\.mia-status-pill--err\s*\{[^}]*color:\s*var\(--text-muted/s)
  })

  it("Model provider uses SELECT_TRACK dialect (not inverted ink outline)", () => {
    const policy = readFileSync(join(here, "../widgets/platform/PolicyEditor.tsx"), "utf8")
    expect(policy).toContain("SELECT_TRACK")
    expect(policy).toContain("SELECT_ACTIVE")
  })

  it("shared StatusMark + statusDotKind used across Pipelines / Threads / Active Users", () => {
    const mark = readFileSync(join(here, "../components/StatusMark.tsx"), "utf8")
    const indicator = readFileSync(join(here, "../components/StatusIndicator.tsx"), "utf8")
    const tokens = readFileSync(join(here, "../theme/tokens.ts"), "utf8")
    expect(mark).toContain("statusDotKind")
    expect(indicator).toContain("StatusIndicator")
    expect(tokens).toMatch(/case "waiting":/)
    expect(css).toMatch(/\.status-mark--ok\b/)
    expect(css).toMatch(/\.status-mark--fail\b/)
    expect(css).toMatch(/\.status-indicator--ok\b/)
  })

  it("go-to ready control stays ink fill (brand ≠ go-to)", () => {
    expect(css).toMatch(
      /\.mia-control\.mia-control--ready[^{]*\{[^}]*background:\s*var\(--text\)/s,
    )
  })
})

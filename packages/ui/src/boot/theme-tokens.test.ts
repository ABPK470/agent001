/**
 * Light theme: brand purple live; status + syntax = ink; select = KPI wash;
 * softs never transparent.
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

describe("light theme color system", () => {
  it("restores brand purple accent (not ink)", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--accent:\s*#7B6FC7/)
    expect(block).not.toMatch(/--accent:\s*var\(--ink\)/)
    expect(block).toMatch(/--logo-mark-live:\s*var\(--accent\)/)
    expect(block).toMatch(/--logo-mark-idle:\s*var\(--ink\)/)
    expect(block).toMatch(/--viewing-as:\s*var\(--accent\)/)
  })

  it("maps status + softs to ink / overlay (never transparent, never traffic chroma)", () => {
    const block = lightThemeBlock()
    expect(block).not.toMatch(/--success-soft:\s*transparent/)
    expect(block).not.toMatch(/--warning-soft:\s*transparent/)
    expect(block).not.toMatch(/--error-soft:\s*transparent/)
    expect(block).not.toMatch(/--info-soft:\s*transparent/)
    expect(block).toMatch(/--success:\s*var\(--ink\)/)
    expect(block).toMatch(/--error:\s*var\(--ink\)/)
    expect(block).toMatch(/--warning:\s*var\(--ink\)/)
    expect(block).toMatch(/--info:\s*var\(--ink\)/)
    expect(block).toMatch(/--success-soft:\s*var\(--overlay-2\)/)
    expect(block).toMatch(/--error-soft:\s*var\(--overlay-2\)/)
    // Reject prior earth / neon status palettes on light.
    expect(block).not.toMatch(/--success:\s*#3f5a4a/)
    expect(block).not.toMatch(/--success:\s*#166534/)
    expect(block).not.toMatch(/--error:\s*#b91c1c/)
  })

  it("maps datatype / syntax tokens to ink (no Event Stream chroma on paper)", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--dt-string:\s*var\(--ink\)/)
    expect(block).toMatch(/--dt-int:\s*var\(--ink\)/)
    expect(block).toMatch(/--dt-date:\s*var\(--ink\)/)
  })

  it("select/hover fills match Active Users KPI washes (overlay-2 / overlay-1)", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--select-fill:\s*var\(--overlay-2\)/)
    expect(block).toMatch(/--hover-fill:\s*var\(--overlay-1\)/)
  })

  it("diff panes keep clear green/red on sheet wash (not ink, not widget paper)", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--diff-surface:\s*#f6f4f1/)
    expect(block).toMatch(/--diff-add:\s*#15803d/)
    expect(block).toMatch(/--diff-del:\s*#b91c1c/)
    expect(block).not.toMatch(/--diff-add:\s*var\(--ink\)/)
    expect(block).not.toMatch(/--diff-del:\s*var\(--ink\)/)
    const src = readFileSync(join(here, "../widgets/platform/CatalogJsonDiff.tsx"), "utf8")
    expect(src).toContain("bg-diff-surface")
    expect(src).toContain("text-diff-add")
    expect(src).toContain("text-diff-del")
  })

  it("policy effects keep clear allow/deny/approval chroma on light", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--policy-allow:\s*#15803d/)
    expect(block).toMatch(/--policy-deny:\s*#b91c1c/)
    expect(block).toMatch(/--policy-approval:\s*#a16207/)
    expect(block).not.toMatch(/--policy-allow:\s*var\(--ink\)/)
    const schema = readFileSync(join(here, "../widgets/platform/policy/selector-schema.ts"), "utf8")
    expect(schema).toContain("text-policy-allow")
    expect(schema).toContain("text-policy-deny")
    expect(schema).toContain("text-policy-approval")
  })

  it("severity callouts use policies dialect (soft wash + thin border + chroma)", () => {
    expect(css).toMatch(
      /\.trace-phase-event\.is-error\s*\{[^}]*background:\s*var\(--policy-deny-soft/s,
    )
    expect(css).toMatch(
      /\.trace-phase-event\.is-warn\s*\{[^}]*background:\s*var\(--policy-approval-soft/s,
    )
    expect(css).toMatch(/\.mia-toast--err\s*\{[^}]*--policy-deny-soft/s)
    expect(css).toMatch(/\.mia-callout--err\s*\{[^}]*--policy-deny-soft/s)
    const ops = readFileSync(join(here, "../widgets/OperationLog.tsx"), "utf8")
    expect(ops).toContain("operationStatusCallout")
    expect(ops).not.toMatch(/failed:\s*"bg-diff-surface/)
    const live = readFileSync(join(here, "../widgets/LiveLogs.tsx"), "utf8")
    expect(live).toContain("bg-policy-deny-soft")
    expect(live).toContain("mia-callout--err")
    expect(live).not.toMatch(/log\.error[\s\S]{0,80}bg-diff-surface/)
  })

  it("shared StatusMark + statusDotKind used across Pipelines / Threads / Active Users", () => {
    const mark = readFileSync(join(here, "../components/StatusMark.tsx"), "utf8")
    const tokens = readFileSync(join(here, "../theme/tokens.ts"), "utf8")
    const pipelines = readFileSync(join(here, "../widgets/pipelines/operation-log-row.tsx"), "utf8")
    const threads = readFileSync(join(here, "../widgets/threads/ThreadRunsPanel.tsx"), "utf8")
    const au = readFileSync(join(here, "../widgets/ActiveUsers.tsx"), "utf8")
    expect(mark).toContain("statusDotKind")
    expect(mark).toContain("status-mark--")
    expect(tokens).toMatch(/case "waiting":/)
    expect(tokens).toMatch(/case "cancelled":/)
    expect(pipelines).toContain('from "../../components/StatusMark"')
    expect(threads).toContain("StatusMark")
    expect(au).toContain("StatusMark")
    expect(css).toMatch(/\.status-mark--ok\b/)
    expect(css).toMatch(/\.status-mark--fail\b/)
    expect(css).toMatch(/\.status-mark--live\b/)
    expect(css).toMatch(
      /\.trace-scope\[data-trace-kind="tools"\]\s*\.trace-scope__lead\s*\{[^}]*color:\s*var\(--text-muted/s,
    )
    expect(css).not.toMatch(
      /\.trace-scope\[data-trace-kind="tools"\]\s*\.trace-scope__lead\s*\{[^}]*--accent/s,
    )
  })

  it("chat severity + ask-user use chroma exceptions (not ink --error/--warning)", () => {
    const chat = readFileSync(join(here, "../widgets/TermChat.tsx"), "utf8")
    const ask = readFileSync(join(here, "../components/AskUserPrompt.tsx"), "utf8")
    expect(chat).toContain("mia-callout--err")
    expect(chat).toContain("mia-callout--warn")
    expect(chat).toMatch(/headerToneClass = "text-text-faint"/)
    expect(ask).toContain("border-accent")
    expect(ask).toContain("bg-accent-soft")
    expect(ask).toContain("text-accent")
    expect(ask).toContain("ArrowUp")
    expect(ask).toContain("mia-callout--err")
    expect(ask).not.toMatch(/from "lucide-react".*Send|import \{[^}]*Send/)
  })

  it("light keeps callout-info chroma (running washes)", () => {
    const block = lightThemeBlock()
    expect(block).toMatch(/--callout-info:\s*#2563eb/)
    expect(block).toMatch(/--callout-info-soft:\s*color-mix/)
  })

  it("JsonViewer uses datatype tokens (not status success/error for scalars)", () => {
    const src = readFileSync(join(here, "../components/JsonViewer.tsx"), "utf8")
    expect(src).toContain("text-datatype-string")
    expect(src).toContain("text-datatype-int")
    expect(src).not.toMatch(/typeof value === "string"[\s\S]{0,80}text-success/)
  })

  it("go-to ready control stays ink fill (brand ≠ go-to)", () => {
    expect(css).toMatch(
      /\.mia-control\.mia-control--ready[^{]*\{[^}]*background:\s*var\(--text\)/s,
    )
  })
})

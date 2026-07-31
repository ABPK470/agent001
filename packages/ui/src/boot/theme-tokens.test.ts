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

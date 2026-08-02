import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  CONFIG_SPLIT_FORM_CLASS,
  CONFIG_SPLIT_FORM_SCROLL_CLASS,
  CONFIG_SPLIT_GRID_CLASS,
  CONFIG_SPLIT_LIST_CLASS,
  ENV_FORM_ROOT_CLASS,
  ENV_POLICY_ALLOWED_CLASS,
  FORBIDDEN_CONFIG_SPLIT_GRID_PATTERN,
} from "./environment-form-layout"

const here = dirname(fileURLToPath(import.meta.url))

function readSibling(fileName: string): string {
  return readFileSync(join(here, fileName), "utf8")
}

function readModal(): string {
  return readFileSync(join(here, "..", "SyncMetadataModal.tsx"), "utf8")
}

function readFormSection(): string {
  return readFileSync(join(here, "..", "form-section.tsx"), "utf8")
}

describe("environment-form-layout", () => {
  it("exports a Connectors-style minmax(0) split grid contract", () => {
    expect(CONFIG_SPLIT_GRID_CLASS).toContain("minmax(16rem,0.95fr)")
    expect(CONFIG_SPLIT_GRID_CLASS).toContain("minmax(0,1.35fr)")
    expect(CONFIG_SPLIT_GRID_CLASS).toContain("minmax(0,auto)")
    expect(CONFIG_SPLIT_GRID_CLASS).toContain("minmax(0,1fr)")
    expect(CONFIG_SPLIT_GRID_CLASS).toContain("lg:grid-rows-1")
    expect(CONFIG_SPLIT_LIST_CLASS).toContain("min-w-0")
    expect(CONFIG_SPLIT_FORM_CLASS).toContain("min-w-0")
    expect(CONFIG_SPLIT_FORM_SCROLL_CLASS).toContain("overflow-y-auto")
    expect(CONFIG_SPLIT_FORM_SCROLL_CLASS).toContain("overscroll-contain")
    expect(ENV_FORM_ROOT_CLASS).toContain("w-full")
    expect(ENV_FORM_ROOT_CLASS).toContain("min-w-0")
    expect(ENV_FORM_ROOT_CLASS).toContain("h-auto")
    expect(ENV_POLICY_ALLOWED_CLASS).toContain("w-full")
    expect(ENV_POLICY_ALLOWED_CLASS).toContain("min-w-0")
    expect(ENV_POLICY_ALLOWED_CLASS).toContain("shrink-0")
  })

  it("SyncMetadataModal uses the split-pane layout tokens", () => {
    const src = readModal()
    expect(src).toContain("CONFIG_SPLIT_GRID_CLASS")
    expect(src).toContain("CONFIG_SPLIT_LIST_CLASS")
    expect(src).toContain("CONFIG_SPLIT_FORM_CLASS")
    expect(src).toContain("CONFIG_SPLIT_FORM_SCROLL_CLASS")
    expect(src).toContain("className={CONFIG_SPLIT_GRID_CLASS}")
    expect(src).toContain("className={CONFIG_SPLIT_LIST_CLASS}")
    expect(src).toContain("className={CONFIG_SPLIT_FORM_SCROLL_CLASS}")

    // Old unconstrained grid — expanding Restricted blew the modal chrome.
    expect(src).not.toMatch(FORBIDDEN_CONFIG_SPLIT_GRID_PATTERN)
  })

  it("Unsaved / Modified chips use theme warning (not raw amber-400)", () => {
    const src = readModal()
    const css = readFileSync(join(here, "../../../boot/index.css"), "utf8")
    const chrome = readFileSync(join(here, "..", "chrome.tsx"), "utf8")
    expect(chrome).toContain("CHIP_DIRTY")
    expect(chrome).toContain("mia-chip-dirty")
    expect(src).toContain("CHIP_DIRTY")
    expect(src).not.toContain("bg-amber-400")
    expect(src).not.toContain("text-amber-400")
    expect(css).toMatch(/\.mia-chip-dirty\s*\{[^}]*color:\s*var\(--warning\)/s)
    expect(css).toMatch(
      /:root\[data-theme="light"\]\s+\.mia-chip-dirty\s*\{[^}]*color:\s*var\(--warning\)/s,
    )
  })

  it("SyncEnvironmentForm and SyncPolicySection keep full-width block layout", () => {
    const form = readSibling("SyncEnvironmentForm.tsx")
    const policy = readSibling("SyncPolicySection.tsx")
    expect(form).toContain("ENV_FORM_ROOT_CLASS")
    expect(form).toContain("className={ENV_FORM_ROOT_CLASS}")
    expect(policy).toContain("ENV_POLICY_ALLOWED_CLASS")
    expect(policy).toContain("className={ENV_POLICY_ALLOWED_CLASS}")
    // Compact toggles — not FormCheck cards (those stretched the Restricted pane).
    expect(policy).toContain("FilterToggles")
    expect(policy).not.toContain("FormCheck")
  })

  it("FormFieldGroup does not wrap controls in <label> (Listbox-safe)", () => {
    const src = readFormSection()
    expect(src).toContain('role="group"')
    expect(src).toContain("aria-label={label}")
    // The field chrome must not nest interactive Listbox triggers in <label>.
    expect(src).not.toMatch(/<label\b[^>]*className="flex min-w-0 flex-col/)
    // Modal owns the surface — sections/fields must not nest mia-surface cards.
    expect(src).not.toMatch(/className=\{?\[["']mia-surface|className="[^"]*mia-surface/)
    expect(src).toContain("mia-form-section")
    expect(src).toContain('className="min-w-0"')
  })
})

/**
 * Usage modal KPI / expand contracts — prompt+completion identity, runs subtitle, no header dupes.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { buildBrowseDetailEntries } from "./admin-browse-detail"

const here = dirname(fileURLToPath(import.meta.url))

describe("usage modal KPIs and expand detail", () => {
  it("API totals use prompt + completion (not an independent SUM)", () => {
    const routes = readFileSync(join(here, "../../../../server/src/api/usage/routes.ts"), "utf8")
    expect(routes).toContain("totalTokens: promptTokens + completionTokens")
    expect(routes).not.toMatch(/totalTokens:\s*totals\.total_tokens/)
  })

  it("LLM-calls hint covers every run status bucket", () => {
    const src = readFileSync(join(here, "UsageModal.tsx"), "utf8")
    expect(src).toContain("hint={formatRunStatusHint(totals)}")
    expect(src).toContain("${totals.completedRuns} ok")
    expect(src).toContain("${totals.failedRuns} failed")
    expect(src).toContain("${totals.cancelledRuns} cancelled")
    expect(src).toContain("crashedRuns")
    expect(src).toContain("runningRuns")

    const routes = readFileSync(join(here, "../../../../server/src/api/usage/routes.ts"), "utf8")
    expect(routes).toContain("cancelledRuns: totals.cancelled_runs")
    expect(routes).toContain("crashedRuns: totals.crashed_runs")
    expect(routes).toContain("runningRuns: totals.running_runs")
  })

  it("KPI strip uses compact shortcuts; Total is prompt + completion", () => {
    const src = readFileSync(join(here, "UsageModal.tsx"), "utf8")
    expect(src).toContain("formatCompact(totals.promptTokens + totals.completionTokens)")
    expect(src).toContain("formatCompact(totals.promptTokens)")
    expect(src).toContain("formatCompact(totals.completionTokens)")
    expect(src).toContain("formatCompact(totals.llmCalls)")
  })

  it("expanded detail omits header-duplicated fields", () => {
    const entries = buildBrowseDetailEntries(
      {},
      {
        runId: "demo-usage-light",
        threadId: "demo-usage-thread-pka",
        displayName: "pka",
        status: "completed",
        model: "gpt-5.4",
        goal: "Rename the settings page",
        promptTokens: 1120,
        completionTokens: 340,
        totalTokens: 1460,
        llmCalls: 2,
      },
    )
    // Simulate Usage expand policy: only ids + token breakdown.
    const keys = ["runId", "threadId", "promptTokens", "completionTokens", "totalTokens", "llmCalls"]
    const filtered = entries.filter((e) => keys.includes(e.key))
    expect(filtered.map((e) => e.key)).toEqual(keys)
    expect(filtered.map((e) => e.key)).not.toContain("status")
    expect(filtered.map((e) => e.key)).not.toContain("model")
    expect(filtered.map((e) => e.key)).not.toContain("displayName")
    expect(filtered.map((e) => e.key)).not.toContain("goal")

    const src = readFileSync(join(here, "UsageModal.tsx"), "utf8")
    expect(src).toContain("usageExpandEntries")
    expect(src).toMatch(/usageExpandEntries[\s\S]*runId[\s\S]*threadId[\s\S]*promptTokens/)
    expect(src).not.toMatch(/usageExpandEntries[\s\S]*displayName/)
  })

  it("detail panel uses hairline rows and fixed label column — not zebra fills", () => {
    const detail = readFileSync(join(here, "admin-browse-detail.tsx"), "utf8")
    expect(detail).toContain("admin-browse-detail__row")
    expect(detail).toContain("border-b border-border-subtle")
    expect(detail).toContain("last:border-b-0")
    expect(detail).toContain("grid-cols-[11rem_minmax(0,1fr)]")
    expect(detail).toContain("bg-transparent")
    expect(detail).not.toContain("bg-overlay-2/80")
    expect(detail).not.toMatch(/odd:|even:|zebra/)
  })

  it("list rows pin tokens and calls in fixed right columns", () => {
    const src = readFileSync(join(here, "UsageModal.tsx"), "utf8")
    expect(src).toContain("usage-row-metrics")
    expect(src).toContain("grid-cols-[100px_80px]")

    const detail = readFileSync(join(here, "admin-browse-detail.tsx"), "utf8")
    // Nest under open chevron: row pad + chevron + gap + ml-6 child inset.
    expect(detail).toContain("ml-[calc(0.75rem+14px+0.75rem+1.5rem)]")
  })

  it("subtitle separates thread title from muted goal body", () => {
    const src = readFileSync(join(here, "UsageModal.tsx"), "utf8")
    expect(src).toContain('className="mr-2 font-medium text-text-secondary"')
    expect(src).toContain('className="text-text-muted"')
    expect(src).not.toContain('className="opacity-80"')
  })

  it("row status uses shared StatusIndicator (icon + muted badge)", () => {
    const src = readFileSync(join(here, "UsageModal.tsx"), "utf8")
    expect(src).toContain('from "../../components/StatusIndicator"')
    expect(src).toContain("<StatusIndicator")
    expect(src).toContain("status={row.status}")
    expect(src).not.toContain("statusTone")
  })

  it("filters include multi-select status badges (UI → API → SQL)", () => {
    const src = readFileSync(join(here, "UsageModal.tsx"), "utf8")
    expect(src).toContain('label="Status"')
    expect(src).toContain("FilterToggles")
    expect(src).toContain('{ value: "completed", label: "Completed" }')
    expect(src).toContain('{ value: "cancelled", label: "Cancelled" }')
    expect(src).not.toMatch(/FilterField label="Status"[\s\S]*Listbox/)

    const client = readFileSync(join(here, "../../client/index.ts"), "utf8")
    expect(client).toContain("status?: string[]")
    expect(client).toContain("value.join(\",\")")

    const routes = readFileSync(join(here, "../../../../server/src/api/usage/routes.ts"), "utf8")
    expect(routes).toContain("status: parseUsageStatuses(query.status)")

    const db = readFileSync(
      join(here, "../../../../server/src/infra/persistence/adapters/sqlite/db/runs.ts"),
      "utf8",
    )
    expect(db).toContain("r.status IN (")
  })
})

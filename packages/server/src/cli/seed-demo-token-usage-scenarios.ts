/**
 * Pure demo fixtures for Token Usage modal — diverse users, models, sizes, times.
 * Run ids are stable (`demo-usage-*`) so the CLI is idempotent.
 */

export const DEMO_USAGE_RUN_PREFIX = "demo-usage-"

export type DemoUsageStatus = "completed" | "failed" | "cancelled"

export interface DemoUsageScenario {
  /** Stable suffix → run id `demo-usage-${id}` */
  id: string
  upn: string
  displayName: string
  isAdmin?: boolean
  threadTitle: string
  goal: string
  status: DemoUsageStatus
  model: string
  promptTokens: number
  completionTokens: number
  llmCalls: number
  /** Hours before "now" when the run started. */
  hoursAgo: number
  /** Run duration in seconds (completed_at = created + duration). */
  durationSec: number
  stepCount: number
  error?: string
}

export const DEMO_USAGE_USERS = [
  { upn: "pka", displayName: "pka", isAdmin: true },
  { upn: "alice", displayName: "Alice Chen", isAdmin: false },
  { upn: "bob", displayName: "Bob Martinez", isAdmin: false },
  { upn: "ops", displayName: "Ops Bot", isAdmin: true },
] as const

/** Spread across time, models, sizes, and outcomes so sort/filter are obvious. */
export const DEMO_USAGE_SCENARIOS: readonly DemoUsageScenario[] = [
  {
    id: "heavy-gpt54",
    upn: "pka",
    displayName: "pka",
    isAdmin: true,
    threadTitle: "Website rebuild",
    goal: "Create a website with landing, about, and contact form. First schema, then API, then frontend.",
    status: "completed",
    model: "gpt-5.4",
    promptTokens: 48_200,
    completionTokens: 9_640,
    llmCalls: 28,
    hoursAgo: 2,
    durationSec: 312,
    stepCount: 42,
  },
  {
    id: "light-gpt54",
    upn: "pka",
    displayName: "pka",
    isAdmin: true,
    threadTitle: "Quick fix",
    goal: "Rename the settings page title and fix the typo in the footer.",
    status: "completed",
    model: "gpt-5.4",
    promptTokens: 1_120,
    completionTokens: 340,
    llmCalls: 2,
    hoursAgo: 1,
    durationSec: 18,
    stepCount: 3,
  },
  {
    id: "mid-claude",
    upn: "alice",
    displayName: "Alice Chen",
    threadTitle: "Dashboard polish",
    goal: "Build a dashboard with KPI cards, a filterable table, and CSV export.",
    status: "completed",
    model: "claude-sonnet-4",
    promptTokens: 22_400,
    completionTokens: 6_100,
    llmCalls: 14,
    hoursAgo: 26,
    durationSec: 195,
    stepCount: 21,
  },
  {
    id: "fail-claude",
    upn: "alice",
    displayName: "Alice Chen",
    threadTitle: "Dashboard polish",
    goal: "Add realtime charts to the dashboard using the metrics API.",
    status: "failed",
    model: "claude-sonnet-4",
    promptTokens: 8_900,
    completionTokens: 1_200,
    llmCalls: 6,
    hoursAgo: 20,
    durationSec: 88,
    stepCount: 9,
    error: "Tool mssql_query failed: Invalid object name 'dbo.MetricsHourly'.",
  },
  {
    id: "bulk-gpt54-mini",
    upn: "bob",
    displayName: "Bob Martinez",
    threadTitle: "Data cleanup",
    goal: "Normalize customer addresses and flag rows with missing postal codes.",
    status: "completed",
    model: "gpt-5.4-mini",
    promptTokens: 95_000,
    completionTokens: 12_400,
    llmCalls: 40,
    hoursAgo: 72,
    durationSec: 540,
    stepCount: 55,
  },
  {
    id: "tiny-mini",
    upn: "bob",
    displayName: "Bob Martinez",
    threadTitle: "Data cleanup",
    goal: "Count how many customers are missing email addresses.",
    status: "completed",
    model: "gpt-5.4-mini",
    promptTokens: 480,
    completionTokens: 90,
    llmCalls: 1,
    hoursAgo: 70,
    durationSec: 6,
    stepCount: 1,
  },
  {
    id: "ops-batch",
    upn: "ops",
    displayName: "Ops Bot",
    isAdmin: true,
    threadTitle: "Nightly sync check",
    goal: "Preview sync for Customer entity uat → prod and summarize drift.",
    status: "completed",
    model: "gpt-5.4",
    promptTokens: 15_600,
    completionTokens: 3_200,
    llmCalls: 9,
    hoursAgo: 10,
    durationSec: 140,
    stepCount: 12,
  },
  {
    id: "ops-cancel",
    upn: "ops",
    displayName: "Ops Bot",
    isAdmin: true,
    threadTitle: "Nightly sync check",
    goal: "Execute the Customer sync plan after preview approval.",
    status: "cancelled",
    model: "gpt-5.4",
    promptTokens: 4_200,
    completionTokens: 600,
    llmCalls: 3,
    hoursAgo: 9,
    durationSec: 45,
    stepCount: 4,
  },
  {
    id: "alice-old",
    upn: "alice",
    displayName: "Alice Chen",
    threadTitle: "Legacy import",
    goal: "Map CSV columns to the Entity Registry Customer table and propose a sync plan.",
    status: "completed",
    model: "gpt-4.1",
    promptTokens: 31_000,
    completionTokens: 7_800,
    llmCalls: 18,
    hoursAgo: 240,
    durationSec: 280,
    stepCount: 27,
  },
  {
    id: "pka-midweek",
    upn: "pka",
    displayName: "pka",
    isAdmin: true,
    threadTitle: "API hardening",
    goal: "Add input validation and error envelopes to the contact form API.",
    status: "completed",
    model: "claude-sonnet-4",
    promptTokens: 11_200,
    completionTokens: 4_400,
    llmCalls: 11,
    hoursAgo: 50,
    durationSec: 160,
    stepCount: 16,
  },
  {
    id: "bob-fail-mini",
    upn: "bob",
    displayName: "Bob Martinez",
    threadTitle: "Reporting",
    goal: "Generate a weekly usage report grouped by model and user.",
    status: "failed",
    model: "gpt-5.4-mini",
    promptTokens: 6_400,
    completionTokens: 800,
    llmCalls: 5,
    hoursAgo: 36,
    durationSec: 62,
    stepCount: 7,
    error: "Budget exceeded for session.",
  },
  {
    id: "alice-recent-mini",
    upn: "alice",
    displayName: "Alice Chen",
    threadTitle: "Copy pass",
    goal: "Rewrite empty-state copy for the Entity Registry workspace.",
    status: "completed",
    model: "gpt-5.4-mini",
    promptTokens: 2_800,
    completionTokens: 1_100,
    llmCalls: 4,
    hoursAgo: 4,
    durationSec: 35,
    stepCount: 5,
  },
]

export function demoUsageRunId(id: string): string {
  return `${DEMO_USAGE_RUN_PREFIX}${id}`
}

export function demoUsageThreadId(upn: string): string {
  return `${DEMO_USAGE_RUN_PREFIX}thread-${upn}`
}

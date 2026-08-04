/**
 * Seed a rich Trace / chat demo universe: ~5 threads × many runs covering
 * direct + planner routes, success / fail / cancel, ask_user, multi system
 * prompts, sync, files, and kitchen-sink complexity.
 *
 * Usage (from packages/server):
 *   npx tsx src/cli/seed-demo-trace-thread.ts
 *   npx tsx src/cli/seed-demo-trace-thread.ts --upn pka
 *
 * Writes to ~/.mia/mia.db (or $MIA_DATA_DIR/mia.db).
 */

import "../boot/load-env.js"
import { randomUUID } from "node:crypto"
import type { TraceEntry } from "@mia/shared-types"
import {
  buildAskUserCancelled,
  buildCancelledMidRun,
  buildDirectFourCalls,
  buildFailedToolRun,
  buildKitchenSink,
  buildMultiSystemAskUser,
  buildPlannerFailThenRecover,
  buildPlannerFiveCalls,
  buildSyncAndFiles,
} from "../api/runs/service/demo-trace-builders.js"
import {
  createThread,
  getDbPath,
  listUsers,
  openDatabase,
  saveRun,
  saveTraceEntry,
  touchThread,
} from "../infra/persistence/adapters/sqlite/index.js"

const args = process.argv.slice(2)
const upnArg = args.find((a) => a.startsWith("--upn="))?.slice(6)
  ?? (args.includes("--upn") ? args[args.indexOf("--upn") + 1] : undefined)

openDatabase()

const users = await listUsers()
const upn = (upnArg ?? users[0]?.upn ?? "").toLowerCase()
if (!upn) {
  console.error("No users in the database. Log in once, then re-run this script.")
  process.exit(1)
}

const now = Date.now()
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

async function persistRun(opts: {
  id: string
  threadId: string
  upn: string
  goal: string
  answer: string | null
  stepCount: number
  createdOffset: number
  completedOffset: number
  displayName: string
  trace: TraceEntry[]
  status?: "completed" | "failed" | "cancelled" | "crashed"
  error?: string | null
}) {
  await saveRun({
    id: opts.id,
    goal: opts.goal,
    status: opts.status ?? "completed",
    answer: opts.answer,
    step_count: opts.stepCount,
    error: opts.error ?? null,
    parent_run_id: null,
    created_at: iso(opts.createdOffset),
    completed_at: iso(opts.completedOffset),
    thread_id: opts.threadId,
    upn: opts.upn,
    display_name: opts.displayName,
  })

  for (let seq = 0; seq < opts.trace.length; seq++) {
    const entry = opts.trace[seq]!
    await saveTraceEntry({
      run_id: opts.id,
      seq,
      data: JSON.stringify(entry),
      created_at: iso(opts.createdOffset + seq * 400),
    })
  }
}

const displayName = users.find((u) => u.upn === upn)?.display_name ?? upn

type SeedRun = {
  label: string
  goal: string
  answer: string | null
  stepCount: number
  createdOffset: number
  completedOffset: number
  trace: TraceEntry[]
  status?: "completed" | "failed" | "cancelled" | "crashed"
  error?: string | null
}

async function seedThread(title: string, runs: SeedRun[]): Promise<string> {
  const thread = await createThread(upn, title)
  touchThread(thread.id)
  const lines: string[] = [`Thread: ${thread.id}  (${title})`]
  for (const r of runs) {
    const id = randomUUID()
    await persistRun({
      id,
      threadId: thread.id,
      upn,
      goal: r.goal,
      answer: r.answer,
      stepCount: r.stepCount,
      createdOffset: r.createdOffset,
      completedOffset: r.completedOffset,
      displayName,
      trace: r.trace,
      status: r.status,
      error: r.error,
    })
    lines.push(
      `  ${r.label}: ${id}  [${r.status ?? "completed"}]  ${r.trace.length} entries`,
    )
  }
  touchThread(thread.id)
  for (const line of lines) console.log(line)
  return thread.id
}

const directTrace = buildDirectFourCalls()
const plannerTrace = buildPlannerFiveCalls()
const kitchenTrace = buildKitchenSink()
const cancelledTrace = buildCancelledMidRun()
const failedTrace = buildFailedToolRun()
const askCancelTrace = buildAskUserCancelled()
const multiSystemTrace = buildMultiSystemAskUser()
const syncFilesTrace = buildSyncAndFiles()
const plannerRecoverTrace = buildPlannerFailThenRecover()

console.log(`Database: ${getDbPath()}`)
console.log(`User:     ${upn}`)
console.log("")

await seedThread("Demo Trace — Direct / Planner / Kitchen sink", [
  {
    label: "direct-4",
    goal: "List top bankers and export a small CSV summary",
    answer: "Top 5 bankers exported to top-bankers.csv.",
    stepCount: 3,
    createdOffset: -180_000,
    completedOffset: -150_000,
    trace: directTrace,
  },
  {
    label: "planner-5",
    goal:
      "Build a small dashboard site with a landing page, metrics page, and export endpoint. Create the schema, API, then frontend.",
    answer: "Dashboard schema, API, and frontend are in place.",
    stepCount: 8,
    createdOffset: -120_000,
    completedOffset: -60_000,
    trace: plannerTrace,
  },
  {
    label: "kitchen-sink",
    goal:
      "Create a website with landing, about, and contact form. First schema, then API, then frontend — verify and repair if needed.",
    answer:
      "Site is ready: landing/about/contact with navy/cream branding. Schema, sync preview, and build all passed after one repair round.",
    stepCount: 18,
    createdOffset: -50_000,
    completedOffset: -5_000,
    trace: kitchenTrace,
  },
])

await seedThread("Demo Trace — Cancel & Fail", [
  {
    label: "cancelled-mid-tool",
    goal: "Refactor auth helpers then run the unit suite",
    answer: null,
    stepCount: 2,
    createdOffset: -90_000,
    completedOffset: -80_000,
    trace: cancelledTrace,
    status: "cancelled",
    error: "This operation was aborted.",
  },
  {
    label: "failed-sql",
    goal: "Query orphaned invoices and email a CSV",
    answer: null,
    stepCount: 1,
    createdOffset: -70_000,
    completedOffset: -65_000,
    trace: failedTrace,
    status: "failed",
    error: "Tool query_mssql failed: Invalid object name 'invoices'.",
  },
  {
    label: "ask-user-cancelled",
    goal: "Pick a deployment window for the payroll cutover",
    answer: null,
    stepCount: 1,
    createdOffset: -55_000,
    completedOffset: -50_000,
    trace: askCancelTrace,
    status: "cancelled",
    error: "This operation was aborted.",
  },
])

await seedThread("Demo Trace — Human & Multi-prompt", [
  {
    label: "multi-system-ask",
    goal: "Confirm which brand palette to ship",
    answer: "Locked navy/cream into brand.json.",
    stepCount: 3,
    createdOffset: -40_000,
    completedOffset: -30_000,
    trace: multiSystemTrace,
  },
  {
    label: "ask-empty-args-cancel",
    goal: "Pick a deployment window for the payroll cutover",
    answer: null,
    stepCount: 1,
    createdOffset: -25_000,
    completedOffset: -20_000,
    trace: askCancelTrace,
    status: "cancelled",
    error: "This operation was aborted.",
  },
])

await seedThread("Demo Trace — Sync & Files", [
  {
    label: "sync-files",
    goal: "Preview client 7 sync, then write a short ops note",
    answer: "Previewed client 7 (+2) and wrote ops/client-7.md.",
    stepCount: 4,
    createdOffset: -35_000,
    completedOffset: -15_000,
    trace: syncFilesTrace,
  },
  {
    label: "direct-export",
    goal: "List top bankers and export a small CSV summary",
    answer: "Top 5 bankers exported to top-bankers.csv.",
    stepCount: 3,
    createdOffset: -14_000,
    completedOffset: -10_000,
    trace: directTrace,
  },
])

await seedThread("Demo Trace — Planner extremes", [
  {
    label: "planner-fail-recover",
    goal: "Add a tiny status badge page and prove the build",
    answer: "Status page shipped; build green after one repair.",
    stepCount: 5,
    createdOffset: -45_000,
    completedOffset: -12_000,
    trace: plannerRecoverTrace,
  },
  {
    label: "planner-happy",
    goal:
      "Build a small dashboard site with a landing page, metrics page, and export endpoint. Create the schema, API, then frontend.",
    answer: "Dashboard schema, API, and frontend are in place.",
    stepCount: 8,
    createdOffset: -11_000,
    completedOffset: -4_000,
    trace: plannerTrace,
  },
  {
    label: "kitchen-again",
    goal:
      "Create a website with landing, about, and contact form. First schema, then API, then frontend — verify and repair if needed.",
    answer:
      "Site is ready: landing/about/contact with navy/cream branding. Schema, sync preview, and build all passed after one repair round.",
    stepCount: 18,
    createdOffset: -3_500,
    completedOffset: -500,
    trace: kitchenTrace,
  },
])

console.log("\nOpen any Demo Trace thread in chat / Trace widget to inspect.")

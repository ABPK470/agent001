/**
 * Seed demo sync / pipeline history — catalog-aware runs for Sync History + Operation Log.
 *
 * Usage (from packages/server):
 *   npx tsx src/cli/seed-demo-sync-history.ts
 *   npx tsx src/cli/seed-demo-sync-history.ts --upn pka
 *   npx tsx src/cli/seed-demo-sync-history.ts --force
 *
 * Writes to ~/.mia/mia.db (or $MIA_DATA_DIR/mia.db).
 * Bootstraps deploy/sync catalog when empty, publishes definitions, then inserts
 * sync_runs rows + event_log entries derived from entity fixtures and flow steps.
 */

import "../boot/load-env.js"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SyncRunStatus } from "@mia/shared-enums"
import { publishSyncDefinitionsFromDb } from "../api/sync/service/definitions.js"
import { loadBootSyncEnvironments } from "../boot/sync-environments.js"
import {
  flushEventStore,
  getDb,
  getDbPath,
  listSessions,
  listSyncDefinitions,
  listUsers,
  openDatabase,
  recordSyncRunFinish,
  recordSyncRunPreview,
  recordSyncRunStart,
  saveEvent,
} from "../infra/persistence/adapters/sqlite/index.js"
import {
  buildDemoSyncEvents,
  buildDemoSyncPlan,
  DEMO_SYNC_PLAN_PREFIX,
  DEMO_SYNC_SCENARIOS,
  demoSyncIso,
} from "./seed-demo-sync-scenarios.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, "../../../..")

const args = process.argv.slice(2)
const upnArg =
  args.find((a) => a.startsWith("--upn="))?.slice(6)
  ?? (args.includes("--upn") ? args[args.indexOf("--upn") + 1] : undefined)
const force = args.includes("--force")

async function resolveDefaultSeedUpn(): Promise<string> {
  const recentSession = (await listSessions())[0]?.upn?.trim().toLowerCase()
  if (recentSession) return recentSession
  return await usersFallbackUpn()
}

async function usersFallbackUpn(): Promise<string> {
  return ((await listUsers())[0]?.upn ?? "").toLowerCase()
}

function ensureUser(upn: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO users (upn, username, display_name, is_admin, source, created_at)
       VALUES (?, ?, ?, 1, 'local', datetime('now'))`,
    )
    .run(upn, upn, upn)
}

function existingDemoPlanIds(): string[] {
  return (
    getDb()
      .prepare(`SELECT plan_id FROM sync_runs WHERE plan_id LIKE ? ORDER BY started_at DESC`)
      .all(`${DEMO_SYNC_PLAN_PREFIX}%`) as Array<{ plan_id: string }>
  ).map((row) => row.plan_id)
}

function clearDemoHistory(): void {
  const db = getDb()
  db.prepare(`DELETE FROM event_log WHERE plan_id LIKE ?`).run(`${DEMO_SYNC_PLAN_PREFIX}%`)
  db.prepare(
    `DELETE FROM event_log WHERE json_extract(data, '$.planId') LIKE ?`,
  ).run(`${DEMO_SYNC_PLAN_PREFIX}%`)
  db.prepare(`DELETE FROM sync_runs WHERE plan_id LIKE ?`).run(`${DEMO_SYNC_PLAN_PREFIX}%`)
}

async function ensureCatalog(): Promise<void> {
  await loadBootSyncEnvironments(projectRoot, [])
  if ((await listSyncDefinitions()).length === 0) {
    console.log("[seed] publishing sync definitions from entity registry…")
    const result = await publishSyncDefinitionsFromDb(projectRoot)
    console.log(
      `[seed] published ${result.definitionCount} definition(s) at ${result.publishedAt}`,
    )
    for (const line of result.stderr) console.warn(`[seed] publish: ${line}`)
  }
}

openDatabase()
await ensureCatalog()

const upn = (upnArg ?? await resolveDefaultSeedUpn()).toLowerCase()
if (!upn) {
  console.error("No users in the database. Log in once, then re-run this script.")
  process.exit(1)
}
ensureUser(upn)

const activeSessionUpn = (await listSessions())[0]?.upn?.trim().toLowerCase() ?? null
if (activeSessionUpn && activeSessionUpn !== upn) {
  console.warn(
    `[seed] note: demo runs will be owned by "${upn}" but your latest session is "${activeSessionUpn}".`,
  )
  console.warn(
    `[seed] Personal Sync History / Pipelines only show data for the logged-in user (Viewing as).`,
  )
  console.warn(`[seed] Re-run with --upn ${activeSessionUpn} --force to match your current login.`)
}

const existing = existingDemoPlanIds()
if (existing.length > 0 && !force) {
  console.log(`Database:  ${getDbPath()}`)
  console.log(`User:      ${upn}`)
  console.log(
    `Demo sync history already seeded (${existing.length} plan(s): ${existing.join(", ")}).`,
  )
  console.log("Nothing to do. Re-run with --force to replace demo sync / pipeline data.")
  process.exit(0)
}
if (force && existing.length > 0) {
  clearDemoHistory()
  console.log(`[seed] cleared ${existing.length} existing demo sync plan(s)`)
}

const baseMs = Date.now()
let eventCount = 0

for (const scenario of DEMO_SYNC_SCENARIOS) {
  const plan = buildDemoSyncPlan(scenario)
  const planJson = JSON.stringify(plan)

  recordSyncRunPreview({
    planId: scenario.planId,
    entityType: scenario.entityType,
    entityId: scenario.entityId,
    entityDisplayName: scenario.displayName,
    source: scenario.source,
    target: scenario.target,
    actorUpn: upn,
    previewTotals: scenario.previewTotals,
    planJson,
  })

  if (scenario.status !== SyncRunStatus.Preview) {
    recordSyncRunStart({
      planId: scenario.planId,
      entityType: scenario.entityType,
      entityId: scenario.entityId,
      entityDisplayName: scenario.displayName,
      source: scenario.source,
      target: scenario.target,
      actorUpn: upn,
      previewTotals: scenario.previewTotals,
    })

    recordSyncRunFinish({
      planId: scenario.planId,
      status: scenario.status,
      error: scenario.status === SyncRunStatus.Failed ? scenario.error ?? "failed" : null,
      executeTotals: scenario.executeTotals ?? scenario.previewTotals,
      durationMs: scenario.durationMs,
    })
  }

  for (const event of buildDemoSyncEvents(scenario, upn, baseMs)) {
    saveEvent(event.type, event.data, demoSyncIso(baseMs, event.atOffsetMs))
    eventCount += 1
  }
}

await flushEventStore()

console.log(`Database:  ${getDbPath()}`)
console.log(`User:      ${upn}`)
console.log(`Plans:     ${DEMO_SYNC_SCENARIOS.length}`)
console.log(`Events:    ${eventCount}`)
console.log("")
for (const scenario of DEMO_SYNC_SCENARIOS) {
  const route = `${scenario.source} → ${scenario.target}`
  const totals = `${scenario.previewTotals.insert} ins · ${scenario.previewTotals.update} upd · ${scenario.previewTotals.delete} del`
  console.log(
    `  ${scenario.planId}  ${scenario.displayName} (${scenario.entityType})  ${route}  ${scenario.status}  ${totals}`,
  )
}
console.log("\nOpen Sync History or Pipelines / Operation Log to inspect.")

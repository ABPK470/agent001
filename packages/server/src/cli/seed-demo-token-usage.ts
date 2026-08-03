/**
 * Seed diverse Token Usage rows for the admin Usage modal.
 *
 * Usage (from packages/server):
 *   npx tsx src/cli/seed-demo-token-usage.ts
 *   npx tsx src/cli/seed-demo-token-usage.ts --force
 *
 * Writes to ~/.mia/mia.db (or $MIA_DATA_DIR/mia.db).
 * Idempotent via stable `demo-usage-*` run ids; `--force` deletes then reseeds.
 */

import "../boot/load-env.js"
import {
  getDb,
  getDbPath,
  openDatabase,
  saveRun,
  saveTokenUsage,
} from "../infra/persistence/adapters/sqlite/index.js"
import {
  DEMO_USAGE_RUN_PREFIX,
  DEMO_USAGE_SCENARIOS,
  DEMO_USAGE_USERS,
  demoUsageRunId,
  demoUsageThreadId,
  type DemoUsageScenario,
} from "./seed-demo-token-usage-scenarios.js"

const args = process.argv.slice(2)
const force = args.includes("--force")

openDatabase()

function isoHoursAgo(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
}

function ensureUser(upn: string, displayName: string, isAdmin: boolean): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO users (upn, username, display_name, is_admin, source, created_at)
       VALUES (?, ?, ?, ?, 'local', datetime('now'))`,
    )
    .run(upn, upn, displayName, isAdmin ? 1 : 0)
  // Keep display names fresh on reseed without wiping real users' admin bit unless demo user.
  if (upn === "alice" || upn === "bob" || upn === "ops" || upn === "pka") {
    getDb()
      .prepare(
        `UPDATE users SET display_name = ?, is_admin = MAX(is_admin, ?) WHERE upn = ?`,
      )
      .run(displayName, isAdmin ? 1 : 0, upn)
  }
}

function ensureThread(upn: string, title: string, createdAt: string): string {
  const id = demoUsageThreadId(upn)
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO threads (id, upn, title, created_at, updated_at, pinned)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(id, upn, title, createdAt, createdAt)
  getDb()
    .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, createdAt, id)
  return id
}

function clearDemoUsage(): void {
  const db = getDb()
  db.prepare(`DELETE FROM runs WHERE id LIKE ?`).run(`${DEMO_USAGE_RUN_PREFIX}%`)
  db.prepare(`DELETE FROM threads WHERE id LIKE ?`).run(`${DEMO_USAGE_RUN_PREFIX}%`)
}

function existingDemoRunCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(1) AS c FROM runs WHERE id LIKE ?`)
    .get(`${DEMO_USAGE_RUN_PREFIX}%`) as { c: number }
  return row.c
}

function seedScenario(scenario: DemoUsageScenario): void {
  const runId = demoUsageRunId(scenario.id)
  const createdAt = isoHoursAgo(scenario.hoursAgo)
  const completedAt = new Date(
    Date.parse(createdAt) + scenario.durationSec * 1000,
  ).toISOString()
  const threadId = ensureThread(scenario.upn, scenario.threadTitle, createdAt)

  saveRun({
    id: runId,
    goal: scenario.goal,
    status: scenario.status,
    answer: scenario.status === "completed" ? "Done." : null,
    step_count: scenario.stepCount,
    error: scenario.error ?? null,
    parent_run_id: null,
    created_at: createdAt,
    completed_at: completedAt,
    thread_id: threadId,
    upn: scenario.upn,
    display_name: scenario.displayName,
  })

  saveTokenUsage({
    run_id: runId,
    prompt_tokens: scenario.promptTokens,
    completion_tokens: scenario.completionTokens,
    total_tokens: scenario.promptTokens + scenario.completionTokens,
    llm_calls: scenario.llmCalls,
    model: scenario.model,
    created_at: createdAt,
  })
}

const before = existingDemoRunCount()
if (before > 0 && !force) {
  console.log(
    `Demo token usage already present (${before} runs). Pass --force to replace.`,
  )
  console.log(`db: ${getDbPath()}`)
  process.exit(0)
}

if (force && before > 0) {
  clearDemoUsage()
  console.log(`Cleared ${before} demo usage runs.`)
}

for (const user of DEMO_USAGE_USERS) {
  ensureUser(user.upn, user.displayName, user.isAdmin)
}

for (const scenario of DEMO_USAGE_SCENARIOS) {
  seedScenario(scenario)
}

const after = existingDemoRunCount()
const models = [...new Set(DEMO_USAGE_SCENARIOS.map((s) => s.model))].sort()
const totalTokens = DEMO_USAGE_SCENARIOS.reduce(
  (sum, s) => sum + s.promptTokens + s.completionTokens,
  0,
)

console.log(`Seeded ${after} token-usage runs across ${DEMO_USAGE_USERS.length} users.`)
console.log(`Models: ${models.join(", ")}`)
console.log(`Total tokens (demo): ${totalTokens.toLocaleString()}`)
console.log(`db: ${getDbPath()}`)
console.log("Open Token Usage and try sort: Newest / Oldest / Most tokens / Least tokens.")

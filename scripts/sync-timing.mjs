#!/usr/bin/env node
/**
 * sync-timing — print per-step + per-SQL timing for a given sync planId.
 *
 * Usage:
 *   node scripts/sync-timing.mjs <planId>
 *   node scripts/sync-timing.mjs <planId> --sql       # include every SQL row
 */

import Database from "better-sqlite3"
import { homedir } from "node:os"
import { join } from "node:path"

const DB_PATH = process.env.MIA_DB ?? join(homedir(), ".mia", "mia.db")

const planId = process.argv[2]
if (!planId) {
  console.error("Usage: node scripts/sync-timing.mjs <planId> [--sql]")
  process.exit(1)
}
const includeSql = process.argv.includes("--sql")

const db = new Database(DB_PATH, { readonly: true })

function fmt(ms) {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(1)
  return `${m}m ${s}s`
}

// 1. Run summary
const run = db.prepare(`SELECT * FROM sync_runs WHERE plan_id = ?`).get(planId)
if (!run) {
  console.error(`No sync_run row for ${planId}`)
  process.exit(2)
}
console.log(`Plan ${planId}`)
console.log(`  ${run.entity_type} ${run.entity_id} (${run.entity_display_name ?? "?"})`)
console.log(`  ${run.source} → ${run.target}  status=${run.status}`)
console.log(`  total: ${fmt(run.duration_ms)}\n`)

// 2. Step timing — pairs of consecutive sync.execute.step events
const steps = db.prepare(`
  SELECT created_at, json_extract(data, '$.step') AS step
  FROM event_log
  WHERE type = 'sync.execute.step'
    AND json_extract(data, '$.planId') = ?
  ORDER BY id
`).all(planId)

console.log("STEPS")
console.log("-----")
for (let i = 0; i < steps.length; i++) {
  const cur = steps[i]
  const next = steps[i + 1]
  const dur = next ? new Date(next.created_at) - new Date(cur.created_at) : null
  console.log(`  ${(cur.step ?? "?").padEnd(28)} ${fmt(dur).padStart(10)}`)
}

// 3. Per-table operation timing
const tableEvents = db.prepare(`
  SELECT type, created_at, data
  FROM event_log
  WHERE type IN ('sync.execute.table.start','sync.execute.table.done')
    AND json_extract(data, '$.planId') = ?
  ORDER BY id
`).all(planId)

const tablePairs = new Map()  // key = table+op, val = { start, end, rowsTotal, rowsApplied }
for (const ev of tableEvents) {
  const d = JSON.parse(ev.data)
  const key = `${d.table}|${d.op}`
  const slot = tablePairs.get(key) ?? {}
  if (ev.type === "sync.execute.table.start") {
    slot.start = ev.created_at
    slot.rowsTotal = d.rowsTotal
  } else {
    slot.end = ev.created_at
    slot.rowsApplied = d.rowsApplied
  }
  slot.table = d.table
  slot.op = d.op
  tablePairs.set(key, slot)
}

console.log("\nTABLE OPS")
console.log("---------")
console.log(`  ${"table".padEnd(32)} ${"op".padEnd(8)} ${"rows".padStart(6)} ${"applied".padStart(8)} ${"elapsed".padStart(10)}`)
for (const slot of tablePairs.values()) {
  const dur = slot.start && slot.end ? new Date(slot.end) - new Date(slot.start) : null
  console.log(
    `  ${slot.table.padEnd(32)} ${slot.op.padEnd(8)} ` +
    `${String(slot.rowsTotal ?? "—").padStart(6)} ${String(slot.rowsApplied ?? "—").padStart(8)} ` +
    `${fmt(dur).padStart(10)}`,
  )
}

// 4. Archive probe timing
const probes = db.prepare(`
  SELECT json_extract(data, '$.table') AS tbl,
         json_extract(data, '$.hasTriggers') AS hasTriggers,
         json_extract(data, '$.durationMs') AS durationMs
  FROM event_log
  WHERE type = 'sync.execute.archive.probe'
    AND json_extract(data, '$.planId') = ?
  ORDER BY id
`).all(planId)
if (probes.length > 0) {
  console.log("\nARCHIVE PROBES (tableHasTriggers)")
  console.log("---------------------------------")
  for (const p of probes) {
    console.log(`  ${p.tbl.padEnd(32)} hasTriggers=${p.hasTriggers ? "yes" : "no "} ${fmt(p.durationMs).padStart(10)}`)
  }
}

// 5. Top-N slowest SQL
const sqlEvents = db.prepare(`
  SELECT json_extract(data, '$.label') AS label,
         json_extract(data, '$.connection') AS connection,
         json_extract(data, '$.durationMs') AS durationMs,
         json_extract(data, '$.rowCount') AS rowCount,
         json_extract(data, '$.sql') AS sql
  FROM event_log
  WHERE type = 'sync.execute.sql'
    AND json_extract(data, '$.opId') = ?
  ORDER BY CAST(json_extract(data, '$.durationMs') AS INT) DESC
`).all(planId)

console.log(`\nSQL (${sqlEvents.length} queries, top 20 by duration)`)
console.log("-----------------------------------")
const top = includeSql ? sqlEvents : sqlEvents.slice(0, 20)
for (const r of top) {
  console.log(`  ${fmt(r.durationMs).padStart(8)}  ${(r.connection ?? "?").padEnd(10)}  ${r.label}`)
}

const totalSqlMs = sqlEvents.reduce((sum, r) => sum + (r.durationMs ?? 0), 0)
console.log(`\nTotal SQL wall-clock attributed: ${fmt(totalSqlMs)} (${sqlEvents.length} queries)`)
console.log(`Total run wall-clock:            ${fmt(run.duration_ms)}`)
console.log(`Unattributed (overhead/awaits):  ${fmt(run.duration_ms - totalSqlMs)}`)

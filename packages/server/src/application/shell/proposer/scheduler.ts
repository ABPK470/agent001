/**
 * F1.5 — Proposer scheduler.
 *
 * Lightweight zero-dependency cron-style scheduler:
 *  - tick every `tickMs` (default 30s)
 *  - for each enabled `proposer_schedule` row whose `next_run_at` is due,
 *    invoke `runProposer()` exactly once
 *  - guarantee "at most one pass per (tenant, source→target) at any time"
 *    via an in-memory mutex set
 *  - retry-with-exponential-backoff: 3 attempts at 30s/2m/8m
 *  - graceful shutdown: `stopScheduler()` waits for in-flight passes to
 *    finish (capped at 60s) before resolving.
 *
 * The cron grammar is the conventional 5-field form
 *   `m h dom mon dow` (UTC). We parse a minimal subset: `*`, lists
 *   (`1,15,30`), step (star-slash-5), and ranges (`9-17`). No "@hourly"
 *   aliases or `L`/`W` — keep it simple, document the subset in the runbook.
 */

import type { AgentHost } from "@mia/agent"
import type { LlmCompletionPort } from "@mia/sync"
import { getDb } from "../../../adapters/persistence/sqlite.js"
import { runProposer } from "./runner.js"

export interface ProposerScheduleRow {
  tenant_id: string
  source: string
  target: string
  cron: string
  enabled: number
  last_run_at: string | null
  next_run_at: string | null
}

export interface SchedulerOptions {
  /** Server boot-host (shared mssql Map). Required when scheduled passes will hit the DB. */
  host?: AgentHost
  tickMs?: number
  /** Optional LLM port (or a getter returning the current port) passed to every scheduled run. */
  llm?: LlmCompletionPort | null | (() => LlmCompletionPort | null)
  /** Hook called whenever a pass succeeds or fails; useful for tests. */
  onRunFinished?: (info: {
    tenantId: string
    source: string
    target: string
    ok: boolean
    error?: string
  }) => void
}

const DEFAULT_TICK_MS = 30_000
const RETRY_DELAYS_MS = [30_000, 120_000, 480_000] as const

const inflight = new Set<string>()
let timer: NodeJS.Timeout | null = null
let stopped = false
let activeRuns = 0
const drainWaiters: Array<() => void> = []

export function startScheduler(opts: SchedulerOptions = {}): void {
  if (timer) return
  stopped = false
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS
  const loop = async (): Promise<void> => {
    if (stopped) return
    try {
      await tick(opts)
    } catch (e) {
      console.warn("[proposer-scheduler] tick failed:", e instanceof Error ? e.message : e)
    } finally {
      if (!stopped) timer = setTimeout(loop, tickMs)
    }
  }
  // Fire immediately, then re-arm.
  timer = setTimeout(loop, 0)
}

export async function stopScheduler(timeoutMs = 60_000): Promise<void> {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (activeRuns === 0) return
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs)
    drainWaiters.push(() => {
      clearTimeout(t)
      resolve()
    })
  })
}

export function schedulerHealth(): {
  running: boolean
  activeRuns: number
  inflight: readonly string[]
} {
  return { running: !stopped, activeRuns, inflight: [...inflight] }
}

// ── tick ────────────────────────────────────────────────────────

async function tick(opts: SchedulerOptions): Promise<void> {
  const due = listDueSchedules(new Date())
  for (const s of due) {
    const key = scheduleKey(s)
    if (inflight.has(key)) continue
    void executeWithRetry(s, opts).catch((e) => {
      console.warn(`[proposer-scheduler] pass ${key} failed terminally:`, e instanceof Error ? e.message : e)
    })
  }
}

async function executeWithRetry(s: ProposerScheduleRow, opts: SchedulerOptions): Promise<void> {
  const key = scheduleKey(s)
  inflight.add(key)
  activeRuns++
  try {
    let lastErr: unknown = null
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      try {
        await runProposer(
          opts.host!,
          { source: s.source, target: s.target },
          {
            tenantId: s.tenant_id,
            triggeredBy: "scheduler",
            trigger: attempt === 0 ? "schedule" : "retry",
            llm: resolveLlm(opts.llm)
          }
        )
        opts.onRunFinished?.({ tenantId: s.tenant_id, source: s.source, target: s.target, ok: true })
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        await sleep(RETRY_DELAYS_MS[attempt]!)
      }
    }
    if (lastErr) {
      opts.onRunFinished?.({
        tenantId: s.tenant_id,
        source: s.source,
        target: s.target,
        ok: false,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr)
      })
    }
    persistScheduleAdvance(s)
  } finally {
    inflight.delete(key)
    activeRuns--
    if (stopped && activeRuns === 0) {
      drainWaiters.splice(0).forEach((fn) => fn())
    }
  }
}

function scheduleKey(s: ProposerScheduleRow): string {
  return `${s.tenant_id}|${s.source}→${s.target}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function resolveLlm(
  v: LlmCompletionPort | null | (() => LlmCompletionPort | null) | undefined
): LlmCompletionPort | null {
  if (typeof v === "function") return v()
  return v ?? null
}

// ── schedule persistence ───────────────────────────────────────

export function listDueSchedules(now: Date): ProposerScheduleRow[] {
  const all = getDb()
    .prepare(`SELECT * FROM proposer_schedule WHERE enabled = 1`)
    .all() as ProposerScheduleRow[]
  return all.filter((s) => isDue(s, now))
}

function isDue(s: ProposerScheduleRow, now: Date): boolean {
  if (s.next_run_at) {
    return new Date(s.next_run_at).getTime() <= now.getTime()
  }
  // Never run before — compute the next match and compare.
  const next = nextCronMatch(s.cron, now)
  if (!next) return false
  return next.getTime() <= now.getTime()
}

function persistScheduleAdvance(s: ProposerScheduleRow): void {
  const now = new Date()
  const next = nextCronMatch(s.cron, new Date(now.getTime() + 60_000))
  getDb()
    .prepare(
      `
    UPDATE proposer_schedule
       SET last_run_at = ?, next_run_at = ?
     WHERE tenant_id = ? AND source = ? AND target = ?
  `
    )
    .run(now.toISOString(), next ? next.toISOString() : null, s.tenant_id, s.source, s.target)
}

export interface UpsertScheduleInput {
  tenantId: string
  source: string
  target: string
  cron: string
  enabled: boolean
  actor: string
}

export function upsertSchedule(i: UpsertScheduleInput): ProposerScheduleRow {
  const next = nextCronMatch(i.cron, new Date())
  getDb()
    .prepare(
      `
    INSERT INTO proposer_schedule (tenant_id, source, target, cron, enabled, next_run_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(tenant_id, source, target) DO UPDATE SET
      cron        = excluded.cron,
      enabled     = excluded.enabled,
      next_run_at = excluded.next_run_at,
      updated_at  = excluded.updated_at,
      updated_by  = excluded.updated_by
  `
    )
    .run(i.tenantId, i.source, i.target, i.cron, i.enabled ? 1 : 0, next ? next.toISOString() : null, i.actor)
  return getDb()
    .prepare(`SELECT * FROM proposer_schedule WHERE tenant_id = ? AND source = ? AND target = ?`)
    .get(i.tenantId, i.source, i.target) as ProposerScheduleRow
}

export function listSchedules(tenantId: string): ProposerScheduleRow[] {
  return getDb()
    .prepare(`SELECT * FROM proposer_schedule WHERE tenant_id = ? ORDER BY source, target`)
    .all(tenantId) as ProposerScheduleRow[]
}

export function deleteSchedule(tenantId: string, source: string, target: string): void {
  getDb()
    .prepare(`DELETE FROM proposer_schedule WHERE tenant_id = ? AND source = ? AND target = ?`)
    .run(tenantId, source, target)
}

// ── cron parsing (minimal but real) ────────────────────────────

export function nextCronMatch(cron: string, after: Date): Date | null {
  const parsed = parseCron(cron)
  if (!parsed) return null
  // We scan minute-by-minute up to a year ahead. Cheap and correct for
  // our 5-field subset.
  const start = new Date(after.getTime() + 60_000 - (after.getTime() % 60_000))
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const d = new Date(start.getTime() + i * 60_000)
    if (matchesCron(parsed, d)) return d
  }
  return null
}

interface ParsedCron {
  minute: ReadonlySet<number>
  hour: ReadonlySet<number>
  dayOfMonth: ReadonlySet<number>
  month: ReadonlySet<number>
  dayOfWeek: ReadonlySet<number>
}

function parseCron(cron: string): ParsedCron | null {
  const parts = cron.trim().split(/\s+/u)
  if (parts.length !== 5) return null
  try {
    return {
      minute: expandField(parts[0]!, 0, 59),
      hour: expandField(parts[1]!, 0, 23),
      dayOfMonth: expandField(parts[2]!, 1, 31),
      month: expandField(parts[3]!, 1, 12),
      dayOfWeek: expandField(parts[4]!, 0, 6)
    }
  } catch {
    return null
  }
}

function expandField(field: string, min: number, max: number): ReadonlySet<number> {
  const out = new Set<number>()
  for (const segment of field.split(",")) {
    const [range, stepStr] = segment.split("/")
    const step = stepStr ? Number(stepStr) : 1
    if (!Number.isFinite(step) || step <= 0) throw new Error(`bad step in "${field}"`)
    let lo = min,
      hi = max
    if (range && range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-")
        lo = Number(a)
        hi = Number(b)
      } else {
        lo = Number(range)
        hi = Number(range)
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || hi < lo) {
        throw new Error(`bad range "${range}" in "${field}"`)
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

function matchesCron(p: ParsedCron, d: Date): boolean {
  const m = d.getUTCMinutes()
  const h = d.getUTCHours()
  const dom = d.getUTCDate()
  const mon = d.getUTCMonth() + 1
  const dow = d.getUTCDay()
  return p.minute.has(m) && p.hour.has(h) && p.month.has(mon) && p.dayOfMonth.has(dom) && p.dayOfWeek.has(dow)
}

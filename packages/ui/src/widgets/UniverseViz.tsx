/**
 * UniverseViz — Real-time Sequence Diagram
 *
 * Renders ALL WebSocket events as a UML-style sequence diagram
 * with nine participant lifelines: Agent, LLM, Tools, Delegates,
 * Memory, Checkpoint, API/Channels, Database, and System.
 *
 * Visual elements:
 *   - Dashed vertical lifelines per participant
 *   - Activation boxes showing active periods (tool execution,
 *     LLM processing, run lifetime, delegation)
 *   - Directed horizontal arrows between lifelines for interactions
 *   - Small circle markers for single-lane events
 *   - Monospace labels with adaptive truncation
 *
 * Data source: wsEventLog (every WS event, up to 2000)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "../store"
import type { WsEvent } from "../types"

// ── Palette ──────────────────────────────────────────────────────

const P = {
  agent:    "#7B6FC7",
  llm:      "#D17877",
  tools:    "#E09145",
  delegate: "#5B98D1",
  memory:   "#4DB6AC",
  ckpt:     "#D4A64A",
  api:      "#4DD0E1",
  db:       "#AB7DDB",
  system:   "#6B7280",
  planner:  "#E879A8",
  ok:       "#5DB078",
  err:      "#E05252",
  warn:     "#D4A64A",
  text:     "#a1a1aa",
  dim:      "#3f3f46",
  dimmer:   "#27272a",
  bg:       "#09090b",
}

// ── Lane definitions ─────────────────────────────────────────────

const LANES = [
  { id: "agent",    label: "Agent",      color: P.agent },
  { id: "llm",      label: "LLM",        color: P.llm },
  { id: "tools",    label: "Tools",      color: P.tools },
  { id: "delegate", label: "Delegates",  color: P.delegate },
  { id: "memory",   label: "Memory",     color: P.memory },
  { id: "ckpt",     label: "Checkpoint", color: P.ckpt },
  { id: "api",      label: "API",        color: P.api },
  { id: "db",       label: "Database",   color: P.db },
  { id: "system",   label: "System",     color: P.system },
  { id: "planner",  label: "Planner",    color: P.planner },
] as const

const LANE_N = LANES.length
const ROW_H  = 26
const TIME_W = 58

// ── Scoped CSS ───────────────────────────────────────────────────

const CSS = `
.uv-row .uv-hit { fill: transparent }
.uv-row:hover .uv-hit { fill: rgba(255,255,255,0.025) }
.uv-row.uv-sel .uv-hit { fill: rgba(255,255,255,0.05) }
`

// ── Diagram row type ─────────────────────────────────────────────

interface DRow {
  time:  string        // formatted HH:MM:SS
  lane:  number        // 0–8 (index into LANES)
  label: string        // short text
  color: string        // marker / arrow color
  arrow?: number       // target lane index (absent = no arrow)
  raw:   WsEvent       // original event for detail panel
}

// ── Activation box type ──────────────────────────────────────────

interface Activation {
  lane:     number
  startIdx: number
  endIdx:   number
  color:    string
}

// ── Helpers ──────────────────────────────────────────────────────

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s
}

function ts(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
  } catch {
    return ""
  }
}

function arrowHeadPts(tipX: number, tipY: number, right: boolean): string {
  const dx = right ? -5 : 5
  return `${tipX},${tipY} ${tipX + dx},${tipY - 3} ${tipX + dx},${tipY + 3}`
}

// ── Event classifier ─────────────────────────────────────────────
//    Maps every WsEvent type to a lane, label, color, and optional
//    arrow target. Handles all known event types; unknown events
//    fall through to the System lane.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classify(ev: WsEvent): DRow {
  const base = { raw: ev, time: ts(ev.timestamp) }
  const t = ev.type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = ev.data as Record<string, any>

  // ── Run lifecycle ──────────────────────────────────────────────
  if (t === "run.queued") {
    const goal = d.goal ? `: ${trunc(String(d.goal), 40)}` : ""
    return { ...base, lane: 0, label: `queued${goal}`, color: P.agent }
  }
  if (t === "run.started")
    return { ...base, lane: 0, label: "run started", color: P.agent, arrow: 4 }
  if (t === "run.completed")
    return { ...base, lane: 0, label: `completed (${fmtTok(d.totalTokens ?? 0)} tok, ${d.stepCount ?? 0} steps)`, color: P.ok, arrow: 4 }
  if (t === "run.failed")
    return { ...base, lane: 0, label: `failed: ${trunc(String(d.error ?? ""), 50)}`, color: P.err }
  if (t === "run.cancelled")
    return { ...base, lane: 0, label: "cancelled", color: P.warn }

  // ── Agent thinking ─────────────────────────────────────────────
  if (t === "agent.thinking")
    return { ...base, lane: 0, label: "thinking", color: P.agent, arrow: 1 }

  // ── Steps (tool execution) ─────────────────────────────────────
  if (t === "step.started")
    return { ...base, lane: 0, label: String(d.action ?? d.name ?? "tool"), color: P.tools, arrow: 2 }
  if (t === "step.completed")
    return { ...base, lane: 2, label: "result", color: P.ok, arrow: 0 }
  if (t === "step.failed")
    return { ...base, lane: 2, label: `error: ${trunc(String(d.error ?? ""), 40)}`, color: P.err, arrow: 0 }

  // ── Token usage ────────────────────────────────────────────────
  if (t === "usage.updated")
    return { ...base, lane: 1, label: `${fmtTok(d.totalTokens ?? 0)} tok / ${d.llmCalls ?? 0} calls`, color: P.llm, arrow: 0 }

  // ── Debug trace (rich trace entries) ───────────────────────────
  if (t === "debug.trace") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = d.entry as Record<string, any> | undefined
    const kind = entry?.kind as string | undefined

    if (kind === "goal")
      return { ...base, lane: 0, label: `goal: ${trunc(String(entry?.text ?? ""), 50)}`, color: P.agent, arrow: 4 }
    if (kind === "iteration")
      return { ...base, lane: 0, label: `iteration ${entry?.current}/${entry?.max}`, color: P.agent }
    if (kind === "thinking")
      return { ...base, lane: 0, label: `thinking: ${trunc(String(entry?.text ?? ""), 50)}`, color: P.agent }
    if (kind === "tool-call")
      return { ...base, lane: 0, label: `${entry?.tool}(${trunc(String(entry?.argsSummary ?? ""), 30)})`, color: P.tools, arrow: 2 }
    if (kind === "tool-result")
      return { ...base, lane: 2, label: trunc(String(entry?.text ?? "result"), 50), color: P.ok, arrow: 0 }
    if (kind === "tool-error")
      return { ...base, lane: 2, label: trunc(String(entry?.text ?? "error"), 50), color: P.err, arrow: 0 }
    if (kind === "answer")
      return { ...base, lane: 0, label: `answer: ${trunc(String(entry?.text ?? ""), 60)}`, color: P.ok }
    if (kind === "error")
      return { ...base, lane: 0, label: `error: ${trunc(String(entry?.text ?? ""), 60)}`, color: P.err }
    if (kind === "usage")
      return { ...base, lane: 1, label: `${fmtTok(entry?.iterationTokens ?? 0)} iter / ${fmtTok(entry?.totalTokens ?? 0)} total`, color: P.llm, arrow: 0 }

    // LLM request / response
    if (kind === "llm-request")
      return { ...base, lane: 0, label: `llm-req (${entry?.messageCount ?? 0} msgs, ${entry?.toolCount ?? 0} tools)`, color: P.llm, arrow: 1 }
    if (kind === "llm-response") {
      const dur = entry?.durationMs ? fmtMs(entry.durationMs) : ""
      const tok = entry?.usage?.totalTokens ? fmtTok(entry.usage.totalTokens) + " tok" : ""
      const tc = entry?.toolCalls?.length ? `${entry.toolCalls.length} calls` : ""
      const parts = [dur, tok, tc].filter(Boolean).join(", ")
      return { ...base, lane: 1, label: `llm-resp (${parts})`, color: P.llm, arrow: 0 }
    }

    // Delegation (sequential)
    if (kind === "delegation-start") {
      const agent = entry?.agentName ? ` [${entry.agentName}]` : entry?.agentId ? ` [${entry.agentId}]` : ""
      return { ...base, lane: 0, label: `delegate${agent}: ${trunc(String(entry?.goal ?? ""), 35)}`, color: P.delegate, arrow: 3 }
    }
    if (kind === "delegation-end") {
      const ok = entry?.status === "done"
      return { ...base, lane: 3, label: `delegate ${entry?.status}${entry?.answer ? ": " + trunc(String(entry.answer), 30) : ""}`, color: ok ? P.ok : P.err, arrow: 0 }
    }
    if (kind === "delegation-iteration")
      return { ...base, lane: 3, label: `sub-iter ${entry?.iteration}/${entry?.maxIterations}`, color: P.delegate, arrow: 0 }

    // Delegation (parallel)
    if (kind === "delegation-parallel-start")
      return { ...base, lane: 0, label: `parallel (${entry?.taskCount} tasks)`, color: P.delegate, arrow: 3 }
    if (kind === "delegation-parallel-end")
      return { ...base, lane: 3, label: `parallel: ${entry?.fulfilled}/${entry?.taskCount} ok`, color: (entry?.rejected ?? 0) > 0 ? P.warn : P.ok, arrow: 0 }

    // User input
    if (kind === "user-input-request")
      return { ...base, lane: 0, label: `input: ${trunc(String(entry?.question ?? ""), 40)}`, color: P.warn }
    if (kind === "user-input-response")
      return { ...base, lane: 0, label: `response: ${trunc(String(entry?.text ?? ""), 40)}`, color: P.agent }

    // ── Planner trace events ──────────────────────────────────
    if (kind === "planner-decision") {
      const should = entry?.shouldPlan ? "yes" : "no"
      return { ...base, lane: 9, label: `decision: ${should} (score ${entry?.score})`, color: entry?.shouldPlan ? P.planner : P.dim, arrow: entry?.shouldPlan ? 0 : undefined }
    }
    if (kind === "planner-generating")
      return { ...base, lane: 9, label: "generating plan...", color: P.planner, arrow: 1 }
    if (kind === "planner-plan-generated")
      return { ...base, lane: 9, label: `plan: ${entry?.stepCount} steps — ${trunc(String(entry?.reason ?? ""), 35)}`, color: P.ok }
    if (kind === "planner-generation-failed")
      return { ...base, lane: 9, label: "plan generation failed", color: P.err }
    if (kind === "planner-output-root-forced")
      return { ...base, lane: 9, label: `output root forced: ${trunc(String(entry?.outputRoot ?? ""), 28)}`, color: P.warn }
    if (kind === "planner-validation-failed")
      return { ...base, lane: 9, label: "validation failed", color: P.err }
    if (kind === "planner-validation-remediated")
      return { ...base, lane: 9, label: "validation auto-remediated", color: P.ok }
    if (kind === "planner-validation-warnings")
      return { ...base, lane: 9, label: `validation warnings: ${entry?.warningCount ?? 0}`, color: P.warn }
    if (kind === "planner-delegation-decision") {
      const yes = entry?.shouldDelegate === true
      return {
        ...base,
        lane: 9,
        label: `delegation gate: ${yes ? "delegate" : "local"} (${trunc(String(entry?.reason ?? ""), 28)})`,
        color: yes ? P.planner : P.dim,
        arrow: yes ? 3 : 2,
      }
    }
    if (kind === "planner-pipeline-start")
      return { ...base, lane: 9, label: `pipeline #${entry?.attempt}/${entry?.maxRetries}`, color: P.planner, arrow: 2 }
    if (kind === "planner-step-start")
      return { ...base, lane: 9, label: `step: ${trunc(String(entry?.stepName ?? ""), 30)} (${entry?.stepType})`, color: P.planner, arrow: entry?.stepType === "subagent_task" ? 3 : 2 }
    if (kind === "planner-step-end") {
      const ok = entry?.status === "completed"
      const validation = !ok && entry?.validationCode ? ` [${String(entry.validationCode)}]` : ""
      return {
        ...base,
        lane: 9,
        label: `step done: ${trunc(String(entry?.stepName ?? ""), 25)} ${ok ? "✓" : "✗"}${validation} ${entry?.durationMs ? fmtMs(entry.durationMs as number) : ""}`,
        color: ok ? P.ok : P.err,
      }
    }
    if (kind === "planner-pipeline-end") {
      const ok = entry?.status === "completed"
      return { ...base, lane: 9, label: `pipeline ${entry?.status}: ${entry?.completedSteps}/${entry?.totalSteps}`, color: ok ? P.ok : P.err }
    }
    if (kind === "planner-verification") {
      const color = entry?.overall === "pass" ? P.ok : entry?.overall === "retry" ? P.warn : P.err
      return { ...base, lane: 9, label: `verify: ${entry?.overall} (${((entry?.confidence as number) ?? 0).toFixed(2)})`, color }
    }
    if (kind === "planner-retry")
      return { ...base, lane: 9, label: `retry #${entry?.attempt}: ${trunc(String(entry?.reason ?? ""), 35)}`, color: P.warn }
    if (kind === "planner-retry-skip")
      return { ...base, lane: 9, label: `retry skip: ${trunc(String(entry?.stepName ?? ""), 24)} (${trunc(String(entry?.reason ?? ""), 20)})`, color: P.warn }
    if (kind === "planner-retry-skipped")
      return { ...base, lane: 9, label: `retry skipped: ${trunc(String(entry?.reason ?? ""), 40)}`, color: P.dim }
    if (kind === "planner-retry-abort")
      return { ...base, lane: 9, label: `retry aborted: ${trunc(String(entry?.reason ?? ""), 34)}`, color: P.err }
    if (kind === "planner-budget-extended")
      return { ...base, lane: 9, label: `budget +${entry?.extensions ?? 0} → ${entry?.effectiveBudget ?? "?"}`, color: P.warn }
    if (kind === "planner-escalation")
      return { ...base, lane: 9, label: `escalate: ${entry?.action} (${trunc(String(entry?.reason ?? ""), 20)})`, color: P.warn }

    // Planner child delegation lifecycle (planner <-> delegate feedback)
    if (kind === "planner-delegation-start")
      return {
        ...base,
        lane: 9,
        label: `child start: ${trunc(String(entry?.stepName ?? ""), 24)}`,
        color: P.delegate,
        arrow: 3,
      }
    if (kind === "planner-delegation-iteration")
      return {
        ...base,
        lane: 3,
        label: `${trunc(String(entry?.stepName ?? "child"), 20)} iter ${entry?.iteration}/${entry?.maxIterations}`,
        color: P.delegate,
        arrow: 9,
      }
    if (kind === "planner-delegation-end") {
      const ok = entry?.status === "done"
      return {
        ...base,
        lane: 3,
        label: `child ${ok ? "done" : "error"}: ${trunc(String(entry?.stepName ?? ""), 22)}`,
        color: ok ? P.ok : P.err,
        arrow: 9,
      }
    }

    if (kind === "workspace_diff") {
      const diff = entry?.diff as { added?: unknown[]; modified?: unknown[]; deleted?: unknown[] } | undefined
      const added = diff?.added?.length ?? 0
      const modified = diff?.modified?.length ?? 0
      const deleted = diff?.deleted?.length ?? 0
      return { ...base, lane: 0, label: `workspace diff +${added} ~${modified} -${deleted}`, color: P.api, arrow: 8 }
    }
    if (kind === "workspace_diff_applied") {
      const summary = entry?.summary as { added?: number; modified?: number; deleted?: number } | undefined
      const added = summary?.added ?? 0
      const modified = summary?.modified ?? 0
      const deleted = summary?.deleted ?? 0
      return { ...base, lane: 6, label: `workspace apply +${added} ~${modified} -${deleted}`, color: P.ok, arrow: 0 }
    }

    // Debug / inspector
    if (kind === "system-prompt")
      return { ...base, lane: 8, label: `system prompt (${entry?.text?.length ?? 0} chars)`, color: P.system, arrow: 0 }
    if (kind === "tools-resolved") {
      const names = (entry?.tools as { name: string }[])?.map((x) => x.name).join(", ") ?? ""
      return { ...base, lane: 8, label: `${entry?.tools?.length ?? 0} tools: ${trunc(names, 50)}`, color: P.system, arrow: 0 }
    }

    return { ...base, lane: 8, label: `trace: ${kind ?? "unknown"}`, color: P.dim }
  }

  // ── Delegation events (non-trace) ──────────────────────────────
  if (t === "delegation.started") {
    const agent = d.agentName ? ` [${d.agentName}]` : d.agentId ? ` [${d.agentId}]` : ""
    return { ...base, lane: 0, label: `delegate${agent}: ${trunc(String(d.goal ?? ""), 30)}`, color: P.delegate, arrow: 3 }
  }
  if (t === "delegation.ended")
    return { ...base, lane: 3, label: `delegate ${d.status}`, color: d.status === "done" ? P.ok : P.err, arrow: 0 }
  if (t === "delegation.iteration")
    return { ...base, lane: 3, label: `sub-iter ${d.iteration}/${d.maxIterations}`, color: P.delegate, arrow: 0 }
  if (t === "delegation.parallel-started")
    return { ...base, lane: 0, label: `parallel (${d.taskCount} tasks)`, color: P.delegate, arrow: 3 }
  if (t === "delegation.parallel-ended")
    return { ...base, lane: 3, label: `parallel done (${d.fulfilled}/${d.taskCount})`, color: (d.rejected ?? 0) > 0 ? P.warn : P.ok, arrow: 0 }

  // ── User input ─────────────────────────────────────────────────
  if (t === "user_input.required")
    return { ...base, lane: 0, label: `input: ${trunc(String(d.question ?? ""), 40)}`, color: P.warn }
  if (t === "user_input.response")
    return { ...base, lane: 0, label: "user responded", color: P.agent }

  // ── System events ──────────────────────────────────────────────
  if (t === "ws.connected")
    return { ...base, lane: 8, label: `connected (v${d.version ?? "?"}, ${d.clients ?? 0} clients)`, color: P.system }
  if (t === "audit") {
    const action = String(d.action ?? "")
    if (action.startsWith("tool."))
      return { ...base, lane: 2, label: `audit: ${action}`, color: P.system, arrow: 8 }
    if (action.startsWith("agent.") || action.startsWith("delegation."))
      return { ...base, lane: 0, label: `audit: ${action}`, color: P.system, arrow: 8 }
    return { ...base, lane: 8, label: `audit: ${action}`, color: P.system }
  }
  if (t === "notification")
    return { ...base, lane: 8, label: `notify: ${trunc(String(d.title ?? ""), 40)}`, color: P.warn, arrow: 6 }
  if (t === "planner.started")
    return { ...base, lane: 9, label: `planner started (${Number(d.score ?? 0).toFixed(2)})`, color: P.planner, arrow: 0 }
  if (t === "planner.completed")
    return { ...base, lane: 9, label: `planner ${d.status} (${d.completedSteps ?? 0}/${d.totalSteps ?? 0})`, color: d.status === "completed" ? P.ok : P.err, arrow: 0 }
  if (t === "planner.pipeline.started")
    return { ...base, lane: 9, label: `pipeline #${d.attempt}/${d.maxRetries}`, color: P.planner, arrow: 2 }
  if (t === "planner.validation.failed")
    return { ...base, lane: 9, label: `validation failed (${(d.diagnostics as unknown[] | undefined)?.length ?? 0})`, color: P.err, arrow: 0 }
  if (t === "planner.validation.remediated")
    return { ...base, lane: 9, label: `validation remediated (${(d.diagnostics as unknown[] | undefined)?.length ?? 0})`, color: P.ok, arrow: 0 }
  if (t === "planner.step.started")
    return { ...base, lane: 9, label: `step: ${trunc(String(d.stepName ?? ""), 26)} (${d.stepType})`, color: P.planner, arrow: d.stepType === "subagent_task" ? 3 : 2 }
  if (t === "planner.step.completed")
    return {
      ...base,
      lane: 9,
      label: `step done: ${trunc(String(d.stepName ?? ""), 22)} ${d.status}${d.acceptanceState ? ` · ${trunc(String(d.acceptanceState), 18)}` : ""}${d.status === "completed" ? "" : d.validationCode ? ` [${trunc(String(d.validationCode), 20)}]` : ""}`,
      color: d.acceptanceState === "accepted" || (d.status === "completed" && !d.acceptanceState) ? P.ok : d.acceptanceState === "pending_verification" || d.acceptanceState === "repair_required" ? P.warn : P.err,
    }
  if (t === "planner.repair.plan")
    return { ...base, lane: 9, label: `repair: ${Array.isArray(d.rerunOrder) && d.rerunOrder.length > 0 ? d.rerunOrder.join(" → ") : "none"}`, color: P.delegate, arrow: 9 }
  if (t === "planner.delegation.started")
    return { ...base, lane: 9, label: `child start: ${trunc(String(d.stepName ?? ""), 24)}`, color: P.delegate, arrow: 3 }
  if (t === "planner.delegation.iteration")
    return { ...base, lane: 3, label: `${trunc(String(d.stepName ?? "child"), 20)} iter ${d.iteration}/${d.maxIterations}`, color: P.delegate, arrow: 9 }
  if (t === "planner.delegation.ended")
    return { ...base, lane: 3, label: `child ${d.status}: ${trunc(String(d.stepName ?? ""), 22)}`, color: d.status === "done" ? P.ok : P.err, arrow: 9 }
  if (t === "approval.required")
    return { ...base, lane: 8, label: `approval: ${d.toolName}`, color: P.warn, arrow: 0 }
  if (t === "checkpoint.saved")
    return { ...base, lane: 0, label: `checkpoint (iter ${d.iteration})`, color: P.ckpt, arrow: 5 }

  // ── Database / API request logging ─────────────────────────────
  if (t === "api.request") {
    const method = d.method ?? "?"
    const url = d.url ? trunc(String(d.url), 30) : "?"
    const status = d.status_code ?? "?"
    const dur = d.duration_ms != null ? ` ${fmtMs(Number(d.duration_ms))}` : ""
    return { ...base, lane: 6, label: `${method} ${url} ${status}${dur}`, color: P.api, arrow: 7 }
  }

  // ── Memory events ──────────────────────────────────────────────
  if (t.startsWith("memory.") || t.startsWith("procedural.")) {
    const action = t.split(".")[1] ?? t
    // ingested/stored/updated: Agent writes to Memory
    if (action === "ingested" || action === "stored" || action === "updated" || action === "created") {
      const tier = d.tier ? ` [${d.tier}]` : ""
      const preview = d.contentPreview ? `: ${trunc(String(d.contentPreview), 30)}` : ""
      return { ...base, lane: 0, label: `mem.${action}${tier}${preview}`, color: P.memory, arrow: 4 }
    }
    // retrieved: Memory context loaded for a run (summary of all tiers)
    if (action === "retrieved") {
      const w = d.working ?? 0; const e = d.episodic ?? 0; const s = d.semantic ?? 0; const p = d.procedural ?? 0
      return { ...base, lane: 4, label: `mem.retrieved w:${w} e:${e} s:${s} p:${p}`, color: P.memory, arrow: 0 }
    }
    // queried/matched/loaded: Memory feeds context to Agent
    if (action === "queried" || action === "matched" || action === "loaded") {
      const detail = d.key ? `: ${trunc(String(d.key), 30)}` : d.type ? `: ${d.type}` : ""
      return { ...base, lane: 4, label: `mem.${action}${detail}`, color: P.memory, arrow: 0 }
    }
    // filtered: entry rejected by salience or dedup
    if (action === "filtered") {
      const reason = d.reason ?? "unknown"
      const preview = d.contentPreview ? `: ${trunc(String(d.contentPreview), 25)}` : ""
      return { ...base, lane: 4, label: `mem.skip(${reason})${preview}`, color: P.warn }
    }
    // consolidated: episodic→semantic promotion
    if (action === "consolidated") {
      return { ...base, lane: 4, label: `mem.consolidate +${d.promoted ?? 0} -${d.pruned ?? 0}`, color: P.memory, arrow: 7 }
    }
    // deleted/pruned/decayed: Memory self-cleanup
    if (action === "deleted" || action === "pruned" || action === "decayed")
      return { ...base, lane: 4, label: `mem.${action}`, color: P.warn }
    return { ...base, lane: 4, label: `mem.${action}`, color: P.memory, arrow: 0 }
  }

  // ── Effect events ──────────────────────────────────────────────
  if (t.startsWith("effect.")) {
    const action = t.split(".")[1] ?? t
    const detail = d.kind ? ` (${d.kind})` : d.path ? `: ${trunc(String(d.path), 30)}` : ""
    // Effects are recorded by tool execution → Tools lane arrows to Checkpoint
    return { ...base, lane: 2, label: `effect.${action}${detail}`, color: P.ckpt, arrow: 5 }
  }

  // ── Conversation / Channels ────────────────────────────────────
  if (t.startsWith("conversation.")) {
    const action = t.split(".")[1] ?? t
    // Inbound message: API→Agent
    if (action === "message" || action === "started")
      return { ...base, lane: 6, label: `conversation.${action}`, color: P.api, arrow: 0 }
    return { ...base, lane: 6, label: `conversation.${action}`, color: P.api }
  }
  if (t.startsWith("message.")) {
    const action = t.split(".")[1] ?? t
    // Outbound message: Agent→API
    if (action === "queued" || action === "sent")
      return { ...base, lane: 0, label: `msg.${action}`, color: P.api, arrow: 6 }
    if (action === "failed")
      return { ...base, lane: 6, label: `msg.${action}`, color: P.err }
    return { ...base, lane: 6, label: `msg.${action}`, color: P.api }
  }

  // ── Unknown ────────────────────────────────────────────────────
  return { ...base, lane: 8, label: t, color: P.dim }
}

// ── Activation box builder ───────────────────────────────────────
//    Scans classified rows to find paired start/end events and
//    produces activation rectangles on the appropriate lifelines.

function buildActivations(rows: DRow[]): Activation[] {
  const result: Activation[] = []
  const openSteps = new Map<string, number>()
  const openLlm: number[] = []
  let runStart: number | null = null
  let delegStart: number | null = null
  let plannerStart: number | null = null

  for (let i = 0; i < rows.length; i++) {
    const ev = rows[i].raw
    const t = ev.type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = ev.data as Record<string, any>

    // Run activation on Agent lane
    if (t === "run.started") runStart = i
    if ((t === "run.completed" || t === "run.failed" || t === "run.cancelled") && runStart != null) {
      result.push({ lane: 0, startIdx: runStart, endIdx: i, color: P.agent })
      runStart = null
    }

    // Step activation on Tools lane
    if (t === "step.started" && d.stepId) openSteps.set(String(d.stepId), i)
    if ((t === "step.completed" || t === "step.failed") && d.stepId) {
      const start = openSteps.get(String(d.stepId))
      if (start != null) {
        result.push({ lane: 2, startIdx: start, endIdx: i, color: t === "step.failed" ? P.err : P.tools })
        openSteps.delete(String(d.stepId))
      }
    }

    // LLM activation on LLM lane
    if (t === "debug.trace") {
      const kind = (d.entry as { kind?: string } | undefined)?.kind
      if (kind === "llm-request") openLlm.push(i)
      if (kind === "llm-response" && openLlm.length > 0) {
        const start = openLlm.pop()!
        result.push({ lane: 1, startIdx: start, endIdx: i, color: P.llm })
      }
    }

    // Delegation activation on Delegates lane
    if (
      t === "delegation.started"
      || (t === "debug.trace" && ["delegation-start", "planner-delegation-start"].includes((d.entry as { kind?: string } | undefined)?.kind ?? ""))
    )
      delegStart = i
    if (
      (
        t === "delegation.ended"
        || (t === "debug.trace" && ["delegation-end", "planner-delegation-end"].includes((d.entry as { kind?: string } | undefined)?.kind ?? ""))
      )
      && delegStart != null
    ) {
      result.push({ lane: 3, startIdx: delegStart, endIdx: i, color: P.delegate })
      delegStart = null
    }

    // Planner activation on Planner lane (pipeline-start → pipeline-end)
    if (t === "debug.trace") {
      const kind = (d.entry as { kind?: string } | undefined)?.kind
      if (kind === "planner-pipeline-start") plannerStart = i
      if (kind === "planner-pipeline-end" && plannerStart != null) {
        const ok = (d.entry as { status?: string } | undefined)?.status === "completed"
        result.push({ lane: 9, startIdx: plannerStart, endIdx: i, color: ok ? P.planner : P.err })
        plannerStart = null
      }
    }
  }

  // Close open activations at the end (still running)
  const last = rows.length - 1
  if (runStart != null) result.push({ lane: 0, startIdx: runStart, endIdx: last, color: P.agent })
  for (const [, start] of openSteps) result.push({ lane: 2, startIdx: start, endIdx: last, color: P.tools })
  for (const start of openLlm) result.push({ lane: 1, startIdx: start, endIdx: last, color: P.llm })
  if (delegStart != null) result.push({ lane: 3, startIdx: delegStart, endIdx: last, color: P.delegate })
  if (plannerStart != null) result.push({ lane: 9, startIdx: plannerStart, endIdx: last, color: P.planner })

  return result
}

// ── Component ────────────────────────────────────────────────────

export function UniverseViz() {
  const wsEventLog = useStore((s) => s.wsEventLog)

  // ── Lane visibility toggles ──────────────────────────────────

  const [visibility, setVisibility] = useState(() => LANES.map(() => true))
  const toggleLane = useCallback(
    (i: number) => setVisibility((prev) => prev.map((v, j) => (j === i ? !v : v))),
    [],
  )

  // ── Container width tracking ─────────────────────────────────

  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef    = useRef<HTMLDivElement>(null)
  const [svgW, setSvgW]           = useState(600)
  const [showLabels, setShowLabels] = useState(true)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width
      setSvgW(w)
      setShowLabels(w >= 400)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Auto-scroll ──────────────────────────────────────────────

  const [autoScroll, setAutoScroll] = useState(true)
  const userScrolledRef = useRef(false)

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [wsEventLog.length, autoScroll])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (!atBottom && !userScrolledRef.current) {
      userScrolledRef.current = true
      setAutoScroll(false)
    }
    if (atBottom && userScrolledRef.current) {
      userScrolledRef.current = false
      setAutoScroll(true)
    }
  }, [])

  // ── Classify all events ──────────────────────────────────────

  const allRows = useMemo(() => wsEventLog.map(classify), [wsEventLog])

  // ── Filter by lane visibility ────────────────────────────────

  const visibleRows = useMemo(
    () => allRows.filter((r) => visibility[r.lane]),
    [allRows, visibility],
  )

  // ── Activation boxes ─────────────────────────────────────────

  const activations = useMemo(
    () => buildActivations(visibleRows),
    [visibleRows],
  )

  // ── Selected row for detail panel ────────────────────────────

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  // clear selection if it becomes out of range
  useEffect(() => {
    if (selectedIdx != null && selectedIdx >= visibleRows.length)
      setSelectedIdx(null)
  }, [selectedIdx, visibleRows.length])

  // ── Lane geometry ────────────────────────────────────────────

  const laneW = (svgW - TIME_W) / LANE_N
  const laneCenters = useMemo(
    () => LANES.map((_, i) => TIME_W + laneW * i + laneW / 2),
    [laneW],
  )

  const svgH = visibleRows.length * ROW_H + 10

  // ── Render ───────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden bg-zinc-950">
      <style>{CSS}</style>

      {/* ── Controls ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-zinc-800 shrink-0 text-[11px]">
        <span className="text-zinc-500 font-semibold uppercase tracking-wider text-[10px]">
          Sequence
        </span>
        <span className="text-zinc-600 font-mono">{visibleRows.length}</span>
        <div className="flex-1 min-w-[20px]" />
        {/* Lane filters */}
        <div className="flex flex-wrap items-center gap-1">
          {LANES.map((l, i) => (
            <button
              key={l.id}
              onClick={() => toggleLane(i)}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity"
              style={{
                color: visibility[i] ? l.color : "#52525b",
                background: visibility[i] ? `${l.color}18` : "transparent",
                opacity: visibility[i] ? 1 : 0.5,
              }}
            >
              {l.label}
            </button>
          ))}
        </div>
        {/* Auto-scroll toggle */}
        <button
          onClick={() => {
            setAutoScroll(true)
            userScrolledRef.current = false
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
          }}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{
            color: autoScroll ? P.ok : "#52525b",
            background: autoScroll ? `${P.ok}18` : "transparent",
          }}
        >
          Auto
        </button>
      </div>

      {/* ── Lane headers (sticky) ── */}
      <div className="flex shrink-0 border-b border-zinc-800/60 overflow-hidden">
        <div
          className="shrink-0 px-1 py-1 text-[9px] text-zinc-600 font-medium"
          style={{ width: TIME_W }}
        >
          Time
        </div>
        {LANES.map((l, i) => (
          <div
            key={l.id}
            className="flex-1 min-w-0 text-center py-1 text-[9px] font-semibold truncate"
            style={{
              color: visibility[i] ? l.color : P.dim,
              opacity: visibility[i] ? 0.8 : 0.3,
            }}
          >
            {l.label}
          </div>
        ))}
      </div>

      {/* ── Scrollable diagram ── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={handleScroll}
      >
        {visibleRows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-xs">
            Awaiting events...
          </div>
        ) : (
          <svg
            width={svgW}
            height={svgH}
            className="block"
            style={{ fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace" }}
          >
            {/* ── Lifeline dashes ── */}
            {LANES.map(
              (l, i) =>
                visibility[i] && (
                  <line
                    key={l.id}
                    x1={laneCenters[i]}
                    y1={0}
                    x2={laneCenters[i]}
                    y2={svgH}
                    stroke={P.dimmer}
                    strokeWidth={1}
                    strokeDasharray="2 4"
                  />
                ),
            )}

            {/* ── Activation boxes ── */}
            {activations.map((a, i) => (
              <rect
                key={`act-${i}`}
                x={laneCenters[a.lane] - 4}
                y={a.startIdx * ROW_H + 2}
                width={8}
                height={(a.endIdx - a.startIdx) * ROW_H + ROW_H - 4}
                rx={1.5}
                fill={a.color}
                opacity={0.10}
              />
            ))}

            {/* ── Event rows ── */}
            {visibleRows.map((row, idx) => {
              const y = idx * ROW_H + ROW_H / 2
              const cx = laneCenters[row.lane]
              const isSelected = selectedIdx === idx
              const hasArrow = row.arrow != null

              // Adaptive label truncation based on available space
              const maxLabelLen = hasArrow
                ? Math.max(10, Math.floor(Math.abs(laneCenters[row.arrow!] - cx) / 5.5))
                : 60

              return (
                <g
                  key={idx}
                  className={`uv-row${isSelected ? " uv-sel" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedIdx(isSelected ? null : idx)}
                >
                  {/* Hit area + selection/hover highlight */}
                  <rect
                    className="uv-hit"
                    x={0}
                    y={idx * ROW_H}
                    width={svgW}
                    height={ROW_H}
                  />

                  {/* Timestamp */}
                  <text
                    x={TIME_W - 6}
                    y={y + 3.5}
                    textAnchor="end"
                    fontSize={9.5}
                    fill="#52525b"
                  >
                    {row.time}
                  </text>

                  {/* Arrow line + arrowhead */}
                  {hasArrow && (
                    <>
                      <line
                        x1={cx}
                        y1={y}
                        x2={laneCenters[row.arrow!]}
                        y2={y}
                        stroke={row.color}
                        strokeWidth={1.2}
                        opacity={0.65}
                      />
                      <polygon
                        points={arrowHeadPts(
                          laneCenters[row.arrow!],
                          y,
                          row.arrow! > row.lane,
                        )}
                        fill={row.color}
                        opacity={0.65}
                      />
                    </>
                  )}

                  {/* Marker circle */}
                  <circle cx={cx} cy={y} r={3} fill={row.color} />

                  {/* Label */}
                  {showLabels && (
                    <text
                      x={
                        hasArrow
                          ? (cx + laneCenters[row.arrow!]) / 2
                          : cx + 8
                      }
                      y={hasArrow ? y - 7 : y + 3.5}
                      textAnchor={hasArrow ? "middle" : "start"}
                      fontSize={9.5}
                      fill={isSelected ? "#d4d4d8" : "#71717a"}
                    >
                      {trunc(row.label, maxLabelLen)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
      </div>

      {/* ── Detail panel ── */}
      {selectedIdx != null && visibleRows[selectedIdx] && (
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/80 px-3 py-2 max-h-40 overflow-y-auto">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-[11px] font-semibold font-mono"
              style={{ color: visibleRows[selectedIdx].color }}
            >
              {visibleRows[selectedIdx].raw.type}
            </span>
            <span className="text-[10px] text-zinc-600">
              {visibleRows[selectedIdx].raw.timestamp}
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setSelectedIdx(null)}
              className="text-zinc-600 hover:text-zinc-400 text-[10px] font-medium"
            >
              close
            </button>
          </div>
          <pre className="text-[10px] text-zinc-500 font-mono whitespace-pre-wrap break-all leading-relaxed">
            {JSON.stringify(visibleRows[selectedIdx].raw.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

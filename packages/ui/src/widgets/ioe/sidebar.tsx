/**
 * IOE sidebar panels — Runs, Compare, Details.
 */

import { useState } from "react"
import type {
    AgentDefinition,
    PolicyRule,
    Run,
    ToolInfo,
} from "../../types"
import { fmtTokens, timeAgo } from "../../util"
import {
    C,
    dur,
    fmtK,
    statusDot,
    type HealthData,
    type LlmConfig,
    type SearchResult,
    type UsageData,
} from "./constants"
import { Tip, TreeItem, TreeSection } from "./primitives"

// ── Details — Active Run + System + Agents + Tools + Policies ────

export function DetailsPanel({
  run,
  agents,
  tools,
  policies,
  llm,
  health,
  usage,
}: {
  run: Run | undefined
  agents: AgentDefinition[]
  tools: ToolInfo[]
  policies: PolicyRule[]
  llm: LlmConfig | null
  health: HealthData | null
  usage: UsageData | null
}) {
  return (
    <div className="text-[13px]">
      <TreeSection title="Active Run" defaultOpen>
        {run ? (
          <>
            <TreeItem label="Status" value={run.status} valueColor={statusDot(run.status)} />
            <TreeItem label="Goal" value={run.goal} />
            <TreeItem label="Steps" value={String(run.stepCount)} />
            <TreeItem label="Tokens" value={fmtTokens(run.totalTokens)} />
            <TreeItem label="LLM Calls" value={String(run.llmCalls)} />
            <TreeItem label="Started" value={timeAgo(run.createdAt)} />
            {run.completedAt && <TreeItem label="Duration" value={dur(run.createdAt, run.completedAt)} />}
            {run.answer && <TreeItem label="Answer" value={run.answer} />}
            {run.error && <TreeItem label="Error" value={run.error} valueColor={C.error} />}
          </>
        ) : (
          <div className="px-4 py-1" style={{ color: C.dim }}>No active run</div>
        )}
      </TreeSection>

      <TreeSection title="System" defaultOpen>
        {llm && (
          <>
            <TreeItem label="Provider" value={llm.provider} />
            <TreeItem label="Model" value={llm.model} />
          </>
        )}
        {health && (
          <TreeItem
            label="Health"
            value={health.status}
            valueColor={health.status === "ok" ? C.success : C.error}
          />
        )}
        {usage && (
          <>
            <TreeItem label="Total Tokens" value={fmtK(usage.totals.totalTokens)} />
            <TreeItem label="Total Runs" value={String(usage.totals.runCount)} />
            <TreeItem label="Completed" value={String(usage.totals.completedRuns)} valueColor={C.success} />
            <TreeItem label="Failed" value={String(usage.totals.failedRuns)} valueColor={C.error} />
            <TreeItem label="LLM Calls" value={String(usage.totals.llmCalls)} />
          </>
        )}
      </TreeSection>

      <TreeSection title={`Agents (${agents.length})`} defaultOpen>
        {agents.map((a) => (
          <div key={a.id} className="px-4 py-1 min-w-0">
            <div className="truncate" style={{ color: C.text }}>{a.name}</div>
            <Tip text={a.description}>
              <div className="truncate" style={{ color: C.dim }}>{a.description}</div>
            </Tip>
            <Tip text={`tools: ${a.tools.join(", ")}`}>
              <div className="truncate" style={{ color: C.muted }}>tools: {a.tools.join(", ")}</div>
            </Tip>
          </div>
        ))}
      </TreeSection>

      <TreeSection title={`Tools (${tools.length})`} defaultOpen>
        {tools.map((t) => (
          <div key={t.name} className="px-4 py-1 min-w-0">
            <div className="truncate" style={{ color: C.accent }}>{t.name}</div>
            <Tip text={t.description}>
              <div className="truncate" style={{ color: C.dim }}>{t.description}</div>
            </Tip>
          </div>
        ))}
      </TreeSection>

      <TreeSection title={`Policies (${policies.length})`}>
        {policies.map((p) => (
          <div key={p.name} className="px-4 py-1 flex items-center gap-2">
            <span
              style={{
                color:
                  p.effect === "deny" ? C.error : p.effect === "require_approval" ? C.warning : C.success,
              }}
            >
              {p.effect}
            </span>
            <span style={{ color: C.text }}>{p.name}</span>
            <span style={{ color: C.dim }}>({p.condition})</span>
          </div>
        ))}
      </TreeSection>
    </div>
  )
}

// ── Compare — Trajectory comparison UI ───────────────────────────

export function ComparePanel({
  runs,
  onCompare,
  result,
  loading,
  error,
}: {
  runs: Run[]
  onCompare: (idA: string, idB: string) => void
  result?: {
    sameGoal: boolean
    toolOverlap: number
    toolCallDelta: number
    iterationDelta: number
    errorRateDelta: number
    moreEfficient: "a" | "b" | "equal"
    summary: string
  } | null
  loading?: boolean
  error?: string | null
}) {
  const [runA, setRunA] = useState<string>("")
  const [runB, setRunB] = useState<string>("")

  const completedRuns = runs.filter((r) => r.status === "completed" || r.status === "failed")

  return (
    <div className="text-[13px] px-3 py-2 space-y-3">
      <div className="uppercase tracking-wide text-[11px] font-semibold" style={{ color: C.muted }}>
        Compare Runs
      </div>
      <div className="space-y-2">
        <div>
          <label className="block mb-1 text-[12px]" style={{ color: C.dim }}>Run A</label>
          <select
            className="w-full text-[13px] rounded px-2 py-1.5 outline-none cursor-pointer"
            style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}` }}
            value={runA}
            onChange={(e) => setRunA(e.target.value)}
          >
            <option value="">Select run...</option>
            {completedRuns.map((r) => (
              <option key={r.id} value={r.id}>
                {r.goal.slice(0, 50)} ({r.status})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block mb-1 text-[12px]" style={{ color: C.dim }}>Run B</label>
          <select
            className="w-full text-[13px] rounded px-2 py-1.5 outline-none cursor-pointer"
            style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}` }}
            value={runB}
            onChange={(e) => setRunB(e.target.value)}
          >
            <option value="">Select run...</option>
            {completedRuns.filter((r) => r.id !== runA).map((r) => (
              <option key={r.id} value={r.id}>
                {r.goal.slice(0, 50)} ({r.status})
              </option>
            ))}
          </select>
        </div>
        <button
          className="w-full px-3 py-1.5 rounded text-[13px] font-medium transition-colors cursor-pointer"
          style={{
            background: runA && runB ? C.accent + "20" : C.elevated,
            color: runA && runB ? C.accent : C.dim,
            border: `1px solid ${runA && runB ? C.accent + "40" : C.border}`,
          }}
          disabled={!runA || !runB || loading}
          onClick={() => { if (runA && runB) onCompare(runA, runB) }}
        >
          {loading ? "Comparing..." : "Compare"}
        </button>
      </div>
      {completedRuns.length < 2 && (
        <div style={{ color: C.dim }}>Need at least 2 completed runs to compare.</div>
      )}
      {error && (
        <div className="rounded px-2 py-1.5 text-[12px]" style={{ background: C.coral + "15", color: C.coral, border: `1px solid ${C.coral}30` }}>
          {error}
        </div>
      )}
      {result && (
        <div className="space-y-2 pt-1" style={{ borderTop: `1px solid ${C.border}` }}>
          <div className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: C.muted }}>Results</div>
          <div className="space-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span style={{ color: C.dim }}>Same goal</span>
              <span style={{ color: result.sameGoal ? C.success : C.warning }}>{result.sameGoal ? "Yes" : "No"}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: C.dim }}>Tool overlap</span>
              <span style={{ color: C.text }}>{Math.round(result.toolOverlap * 100)}%</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: C.dim }}>Tool call Δ</span>
              <span style={{ color: result.toolCallDelta > 0 ? C.coral : result.toolCallDelta < 0 ? C.success : C.muted }}>
                {result.toolCallDelta > 0 ? "+" : ""}{result.toolCallDelta}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: C.dim }}>Iteration Δ</span>
              <span style={{ color: result.iterationDelta > 0 ? C.coral : result.iterationDelta < 0 ? C.success : C.muted }}>
                {result.iterationDelta > 0 ? "+" : ""}{result.iterationDelta}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: C.dim }}>Error rate Δ</span>
              <span style={{ color: result.errorRateDelta > 0 ? C.coral : result.errorRateDelta < 0 ? C.success : C.muted }}>
                {result.errorRateDelta > 0 ? "+" : ""}{(result.errorRateDelta * 100).toFixed(1)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: C.dim }}>More efficient</span>
              <span style={{ color: C.accent }}>
                {result.moreEfficient === "a" ? "Run A" : result.moreEfficient === "b" ? "Run B" : "Equal"}
              </span>
            </div>
          </div>
          <div className="rounded px-2 py-1.5 text-[12px] whitespace-pre-wrap" style={{ background: C.elevated, color: C.textSecondary, border: `1px solid ${C.border}` }}>
            {result.summary}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Runs ─────────────────────────────────────────────────────────

export function RunsPanel({
  runs,
  activeRunId,
  onSelect,
}: {
  runs: Run[]
  activeRunId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="text-[13px]">
      {runs.length === 0 ? (
        <div className="px-4 py-3" style={{ color: C.dim }}>No runs yet</div>
      ) : (
        runs.map((r) => (
          <button
            key={r.id}
            className="w-full text-left flex items-start gap-2 px-3 py-1.5 transition-colors hover:bg-white/[0.03] cursor-pointer"
            style={{ background: r.id === activeRunId ? "rgba(123,111,199,0.08)" : "transparent" }}
            onClick={() => onSelect(r.id)}
          >
            <span
              className="inline-block w-2 h-2 rounded-full mt-1 shrink-0"
              style={{ background: statusDot(r.status) }}
            />
            <div className="min-w-0 flex-1">
              <Tip text={r.goal}>
                <div className="truncate" style={{ color: C.text }}>{r.goal}</div>
              </Tip>
              <div className="flex items-center gap-2 mt-0.5" style={{ color: C.dim }}>
                <span>{r.status}</span>
                <span>{timeAgo(r.createdAt)}</span>
                {r.stepCount > 0 && <span>{r.stepCount} steps</span>}
                {r.totalTokens > 0 && <span>{fmtTokens(r.totalTokens)} tk</span>}
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  )
}

// ── Search results ───────────────────────────────────────────────

export function SearchResultsList({ results }: { results: SearchResult[] | null }) {
  if (!results) return null
  return (
    <div className="mt-2 flex flex-col gap-0.5">
      {results.length === 0 && (
        <div className="text-[13px] px-1" style={{ color: C.muted }}>No results</div>
      )}
      {results.map((r, i) => (
        <div
          key={i}
          className="flex items-center gap-2 px-2 py-1 rounded text-[13px] hover:bg-white/5 cursor-pointer"
          style={{ color: C.textSecondary }}
        >
          <span className="text-[13px] uppercase shrink-0 w-8" style={{ color: C.dim }}>{r.type}</span>
          <Tip text={r.text}>
            <span className="truncate">{r.text}</span>
          </Tip>
          {r.detail && (
            <span className="ml-auto shrink-0 text-[13px]" style={{ color: C.dim }}>{r.detail}</span>
          )}
        </div>
      ))}
    </div>
  )
}

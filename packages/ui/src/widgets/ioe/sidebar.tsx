/**
 * IOE sidebar panels — Explorer, Runs, Agents/Tools, Notifications.
 */

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

// ── Explorer ─────────────────────────────────────────────────────

export function ExplorerPanel({
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
            <TreeItem label="LLM Calls" value={String(usage.totals.llmCalls)} />
          </>
        )}
      </TreeSection>

      <TreeSection title={`Agents (${agents.length})`} defaultOpen>
        {agents.map((a) => (
          <TreeItem key={a.id} label={a.name} value={`${a.tools.length} tools`} />
        ))}
      </TreeSection>

      <TreeSection title={`Tools (${tools.length})`} defaultOpen>
        {tools.map((t) => (
          <TreeItem key={t.name} label={t.name} value={t.description} />
        ))}
      </TreeSection>

      <TreeSection title={`Policies (${policies.length})`} defaultOpen>
        {policies.map((p) => (
          <TreeItem
            key={p.name}
            label={p.name}
            value={p.effect}
            valueColor={
              p.effect === "deny" ? C.error : p.effect === "require_approval" ? C.warning : C.success
            }
          />
        ))}
      </TreeSection>
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
            className="w-full text-left flex items-start gap-2 px-3 py-1.5 transition-colors hover:bg-white/[0.03]"
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

// ── Agents & Tools ───────────────────────────────────────────────

export function AgentsToolsPanel({
  agents,
  tools,
  policies,
}: {
  agents: AgentDefinition[]
  tools: ToolInfo[]
  policies: PolicyRule[]
}) {
  return (
    <div className="text-[13px]">
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

// ── Notifications ────────────────────────────────────────────────

export function NotificationsPanel({
  notifications,
  onRead,
}: {
  notifications: Array<{
    id: string
    type: string
    title: string
    message: string
    read: boolean
    createdAt: string
  }>
  onRead: (id: string) => void
}) {
  return (
    <div className="text-[13px]">
      {notifications.length === 0 ? (
        <div className="px-4 py-3" style={{ color: C.dim }}>No notifications</div>
      ) : (
        notifications.slice(0, 50).map((n) => (
          <div
            key={n.id}
            className="px-3 py-1.5 transition-colors hover:bg-white/[0.03] cursor-pointer"
            style={{ opacity: n.read ? 0.5 : 1 }}
            onClick={() => {
              if (!n.read) onRead(n.id)
            }}
          >
            <div className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  background: n.read
                    ? C.dim
                    : n.type.includes("failed")
                      ? C.error
                      : n.type.includes("approval")
                        ? C.warning
                        : C.accent,
                }}
              />
              <Tip text={n.title}>
                <span className="truncate" style={{ color: C.text }}>{n.title}</span>
              </Tip>
              <span className="ml-auto shrink-0 text-[13px]" style={{ color: C.dim }}>
                {timeAgo(n.createdAt)}
              </span>
            </div>
            <Tip text={n.message}>
              <div className="pl-3.5 truncate mt-0.5" style={{ color: C.muted }}>{n.message}</div>
            </Tip>
          </div>
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

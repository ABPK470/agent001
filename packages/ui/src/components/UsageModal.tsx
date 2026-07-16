/**
 * UsageModal — token consumption tracking modal.
 */

import { Activity, Hash, MessageSquare, Zap } from "lucide-react"
import { useEffect, useState } from "react"
import { api } from "../api"
import { ModalShell } from "../widgets/entity-registry/ModalShell"
import { MODAL_ADMIN_PANEL } from "../widgets/entity-registry/modal-overlay"

interface UsageData {
  totals: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    llmCalls: number
    runCount: number
  }
  runs: Array<{
    runId: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    llmCalls: number
    model: string
    createdAt: string
  }>
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export function UsageModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getUsage().then((d) => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  return (
    <ModalShell
      title="Token Usage"
      subtitle="Token consumption across all agent runs. Included with GitHub Copilot Pro — no per-token cost."
      icon={<Activity size={20} className="text-text-muted" />}
      onClose={onClose}
      widthClass={MODAL_ADMIN_PANEL}
      size="default"
    >
      {loading ? (
        <div className="flex flex-1 items-center justify-center py-12 text-sm text-text-muted">
          Loading…
        </div>
      ) : !data ? (
        <div className="flex flex-1 items-center justify-center py-12 text-sm text-text-muted">
          Failed to load usage data.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid shrink-0 grid-cols-2 gap-3 px-6 pb-4 pt-2 sm:grid-cols-4">
            <StatCard icon={<Zap size={15} />} label="Total Tokens" value={formatNumber(data.totals.totalTokens)} />
            <StatCard icon={<MessageSquare size={15} />} label="Prompt" value={formatNumber(data.totals.promptTokens)} />
            <StatCard icon={<MessageSquare size={15} />} label="Completion" value={formatNumber(data.totals.completionTokens)} />
            <StatCard icon={<Hash size={15} />} label="LLM Calls" value={formatNumber(data.totals.llmCalls)} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 show-scrollbar">
            <div className="mb-3 text-sm font-medium text-text-secondary">
              Per-run breakdown ({data.totals.runCount} runs)
            </div>
            {data.runs.length === 0 ? (
              <div className="py-6 text-center text-sm text-text-muted">
                No usage data yet. Start an agent run to track tokens.
              </div>
            ) : (
              <div className="space-y-1.5">
                {data.runs.map((run) => (
                  <div
                    key={run.runId}
                    className="flex items-center gap-3 rounded-xl bg-overlay-2 px-4 py-2.5 text-[13px]"
                  >
                    <span className="w-[6rem] shrink-0 font-mono text-[12px] text-text-muted">
                      {new Date(run.createdAt).toLocaleString(undefined, {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                      })}
                    </span>
                    <span className="shrink-0 font-mono text-[12px] text-text-muted">
                      {run.model}
                    </span>
                    <div className="flex-1" />
                    <span className="font-medium tabular-nums text-text">{formatNumber(run.totalTokens)} tok</span>
                    <span className="tabular-nums text-[12px] text-text-muted">{run.llmCalls} calls</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  )
}

function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-xl px-4 py-3 ${accent ? "border border-accent/15 bg-accent/10" : "border border-border-subtle bg-overlay-2"}`}>
      <div className={`flex items-center gap-1.5 text-[12px] font-medium ${accent ? "text-accent" : "text-text-muted"}`}>
        {icon}
        {label}
      </div>
      <div className={`text-xl font-semibold tabular-nums ${accent ? "text-accent" : "text-text"}`}>
        {value}
      </div>
    </div>
  )
}

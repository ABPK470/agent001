/**
 * UsageModal — token consumption tracking modal.
 *
 * Shows cumulative token usage, per-run breakdown, and model info.
 * GitHub Copilot Pro includes GitHub Models API — no per-token cost,
 * but rate limits apply.
 */

import { Activity, Hash, MessageSquare, X, Zap } from "lucide-react"
import { useEffect, useState } from "react"
import { api } from "../api"

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl w-full max-w-[720px] h-[85vh] max-sm:h-[92vh] mx-4 sm:mx-auto flex flex-col shadow-2xl max-sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 shrink-0">
          <div className="flex items-center gap-2.5">
            <Activity size={20} className="text-accent" />
            <h2 className="text-base font-semibold text-text">Token Usage</h2>
          </div>
          <button
            className="text-text-muted hover:text-text p-1 rounded"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <p className="px-6 text-[13px] text-text-muted leading-relaxed -mt-2 mb-4">
          Token consumption across all agent runs. Included with GitHub Copilot Pro — no per-token cost.
        </p>

        {loading ? (
          <div className="text-text-muted text-sm text-center py-8">Loading...</div>
        ) : !data ? (
          <div className="text-text-muted text-sm text-center py-8">Failed to load usage data.</div>
        ) : (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 mb-5">
              <StatCard icon={<Zap size={15} />} label="Total Tokens" value={formatNumber(data.totals.totalTokens)} accent />
              <StatCard icon={<MessageSquare size={15} />} label="Prompt" value={formatNumber(data.totals.promptTokens)} />
              <StatCard icon={<MessageSquare size={15} />} label="Completion" value={formatNumber(data.totals.completionTokens)} />
              <StatCard icon={<Hash size={15} />} label="LLM Calls" value={formatNumber(data.totals.llmCalls)} />
            </div>

            {/* Per-run breakdown */}
            <div className="flex-1 overflow-y-auto px-6 pb-5 min-h-0">
              <div className="text-[13px] text-text-muted mb-2 font-medium">
                Per-run breakdown ({data.totals.runCount} runs)
              </div>
              {data.runs.length === 0 ? (
                <div className="text-text-muted text-sm text-center py-6">
                  No usage data yet. Start an agent run to track tokens.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {data.runs.map((run) => (
                    <div
                      key={run.runId}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg bg-base text-[13px]"
                    >
                      <span className="text-text-muted font-mono text-[11px] w-[5.5rem] shrink-0">
                        {new Date(run.createdAt).toLocaleString(undefined, {
                          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                        })}
                      </span>
                      <span className="text-text-muted font-mono text-[11px] shrink-0">
                        {run.model}
                      </span>
                      <div className="flex-1" />
                      <span className="text-text-secondary tabular-nums">{formatNumber(run.totalTokens)} tok</span>
                      <span className="text-text-muted tabular-nums text-[11px]">{run.llmCalls} calls</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-base rounded-xl px-3 py-2.5 flex flex-col gap-1">
      <div className={`flex items-center gap-1.5 text-[11px] ${accent ? "text-accent" : "text-text-muted"}`}>
        {icon}
        {label}
      </div>
      <div className={`text-lg font-semibold tabular-nums ${accent ? "text-accent" : "text-text"}`}>
        {value}
      </div>
    </div>
  )
}

/**
 * ToolStats — performance metrics per tool.
 *
 * Shows call count, average duration, and failure rate for each tool used.
 * Derived from step data in the current run.
 */

import { useStore } from "../store"
import { formatMs } from "../util"

interface ToolMetric {
  name: string
  calls: number
  avgMs: number
  failures: number
}

export function ToolStats() {
  const steps = useStore((s) => s.steps)

  // Aggregate metrics by tool
  const metrics = new Map<string, ToolMetric>()
  for (const step of steps) {
    const existing = metrics.get(step.action) ?? { name: step.action, calls: 0, avgMs: 0, failures: 0 }
    existing.calls++
    if (step.status === "failed") existing.failures++
    const duration = step.startedAt && step.completedAt
      ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
      : 0
    existing.avgMs = Math.round(
      (existing.avgMs * (existing.calls - 1) + duration) / existing.calls,
    )
    metrics.set(step.action, existing)
  }

  const sorted = [...metrics.values()].sort((a, b) => b.calls - a.calls)
  const maxCalls = Math.max(...sorted.map((m) => m.calls), 1)

  if (sorted.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-[11px]">
        No tool data yet
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {sorted.map((metric) => {
        const failRate = metric.calls > 0 ? metric.failures / metric.calls : 0
        const barWidth = (metric.calls / maxCalls) * 100

        return (
          <div key={metric.name} className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-text font-medium font-mono">{metric.name}</span>
              <span className="text-text-muted">
                {metric.calls}× · {formatMs(metric.avgMs)} avg
                {metric.failures > 0 && (
                  <span className="text-error ml-1">{metric.failures} fail</span>
                )}
              </span>
            </div>

            {/* Bar */}
            <div className="h-1.5 bg-base rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${barWidth}%`,
                  background: failRate > 0.5
                    ? "var(--color-error)"
                    : failRate > 0
                    ? "var(--color-warning)"
                    : "var(--color-accent)",
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

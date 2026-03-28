/**
 * StepTimeline — visual timeline of tool calls.
 *
 * Vertical timeline showing each step with status, duration, and details.
 * Currently running step pulses. Click to expand input/output.
 */

import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react"
import { useState } from "react"
import { useStore } from "../store"
import { formatMs } from "../util"

export function StepTimeline() {
  const steps = useStore((s) => s.steps)
  const [expanded, setExpanded] = useState<string | null>(null)

  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        No steps yet
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto space-y-0">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1
        const isRunning = step.status === "running"
        const duration = step.startedAt && step.completedAt
          ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
          : null

        const StatusIcon = isRunning
          ? Loader2
          : step.status === "completed"
          ? CheckCircle2
          : step.status === "failed"
          ? XCircle
          : Circle

        return (
          <div key={step.id} className="flex gap-3">
            {/* Timeline line + icon */}
            <div className="flex flex-col items-center shrink-0">
              <StatusIcon
                size={18}
                className={`mt-0.5 ${
                  isRunning
                    ? "text-accent animate-spin"
                    : step.status === "completed"
                    ? "text-success"
                    : step.status === "failed"
                    ? "text-error"
                    : "text-text-muted"
                }`}
              />
              {!isLast && (
                <div className="w-px flex-1 bg-elevated my-1" />
              )}
            </div>

            {/* Content */}
            <div
              className="flex-1 pb-3 cursor-pointer"
              onClick={() => setExpanded(expanded === step.id ? null : step.id)}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">{step.name}</span>
                {duration !== null && (
                  <span className="text-[13px] text-text-muted font-mono">
                    {formatMs(duration)}
                  </span>
                )}
              </div>
              <div className="text-[13px] text-text-muted mt-0.5">
                {step.action}
                {step.error && (
                  <span className="text-error ml-2">{step.error}</span>
                )}
              </div>

              {/* Expanded detail */}
              {expanded === step.id && (
                <div className="mt-2 space-y-2">
                  {step.input && Object.keys(step.input).length > 0 && (
                    <div>
                      <span className="text-[13px] text-text-muted uppercase tracking-wide">Input</span>
                      <pre className="text-[13px] font-mono text-text-secondary bg-base rounded-lg p-2 mt-0.5 max-h-32 overflow-auto">
                        {JSON.stringify(step.input, null, 2)}
                      </pre>
                    </div>
                  )}
                  {step.output && Object.keys(step.output).length > 0 && (
                    <div>
                      <span className="text-[13px] text-text-muted uppercase tracking-wide">Output</span>
                      <pre className="text-[13px] font-mono text-text-secondary bg-base rounded-lg p-2 mt-0.5 max-h-32 overflow-auto">
                        {JSON.stringify(step.output, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

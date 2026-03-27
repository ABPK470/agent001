/**
 * StepTimeline — visual timeline of tool calls.
 *
 * Vertical timeline showing each step with status, duration, and details.
 * Currently running step pulses. Click to expand input/output.
 */

import { useState } from "react"
import { useStore } from "../store"
import { formatMs, statusColor } from "../util"

export function StepTimeline() {
  const steps = useStore((s) => s.steps)
  const [expanded, setExpanded] = useState<string | null>(null)

  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-[11px]">
        No steps yet
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1
        const isRunning = step.status === "running"
        const duration = step.startedAt && step.completedAt
          ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
          : null

        return (
          <div key={step.id} className="flex gap-3">
            {/* Timeline line + dot */}
            <div className="flex flex-col items-center shrink-0">
              <div
                className={`w-2.5 h-2.5 rounded-full border-2 mt-1 ${isRunning ? "animate-pulse" : ""}`}
                style={{
                  borderColor: statusColor(step.status),
                  background: step.status === "completed" ? statusColor(step.status) : "transparent",
                }}
              />
              {!isLast && (
                <div className="w-px flex-1 bg-border my-1" />
              )}
            </div>

            {/* Content */}
            <div
              className={`flex-1 pb-3 cursor-pointer ${isLast ? "" : ""}`}
              onClick={() => setExpanded(expanded === step.id ? null : step.id)}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-text">{step.name}</span>
                {duration !== null && (
                  <span className="text-[10px] text-text-muted font-mono">
                    {formatMs(duration)}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-text-muted mt-0.5">
                {step.action}
                {step.error && (
                  <span className="text-error ml-2">{step.error}</span>
                )}
              </div>

              {/* Expanded detail */}
              {expanded === step.id && (
                <div className="mt-2 space-y-2">
                  {Object.keys(step.input).length > 0 && (
                    <div>
                      <span className="text-[10px] text-text-muted uppercase">Input</span>
                      <pre className="text-[10px] font-mono text-text-secondary bg-base rounded p-2 mt-0.5 overflow-auto max-h-32">
                        {JSON.stringify(step.input, null, 2)}
                      </pre>
                    </div>
                  )}
                  {Object.keys(step.output).length > 0 && (
                    <div>
                      <span className="text-[10px] text-text-muted uppercase">Output</span>
                      <pre className="text-[10px] font-mono text-text-secondary bg-base rounded p-2 mt-0.5 overflow-auto max-h-32">
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

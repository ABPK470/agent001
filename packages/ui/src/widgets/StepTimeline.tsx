/**
 * StepTimeline — visual timeline of tool calls.
 *
 * Vertical timeline showing each step with status, duration, and details.
 * Currently running step pulses. Failed steps show retry info.
 * Click to expand input/output.
 */

import { CheckCircle2, Circle, ListTree, Loader2, RotateCcw, XCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { CodeBlock } from "../components/CodeBlock"
import { EmptyState } from "../components/EmptyState"
import { extractToolCode, ToolStepOutput } from "../components/tool-code-display"
import { JsonViewer } from "../components/JsonViewer"
import { RunStatus } from "../enums"
import { useStore } from "../store"
import { formatMs } from "../util"

export function StepTimeline() {
  const steps = useStore((s) => s.steps)
  const [expanded, setExpanded] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new steps are added, but only if already near
  // the bottom (within 120px) so we don't hijack the user scrolling up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    if (dist < 120) el.scrollTop = el.scrollHeight
  }, [steps.length])

  // Keep the running step in view even when the user hasn't scrolled away.
  const hasRunning = steps.some((s) => s.status === RunStatus.Running)
  useEffect(() => {
    if (!hasRunning) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [hasRunning])

  if (steps.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState icon={ListTree} message="No steps yet" />
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto space-y-0">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1
        const isRunning = step.status === RunStatus.Running
        const duration = step.startedAt && step.completedAt
          ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
          : null

        const StatusIcon = isRunning
          ? Loader2
          : step.status === RunStatus.Completed
          ? CheckCircle2
          : step.status === RunStatus.Failed
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
                    : step.status === RunStatus.Completed
                    ? "text-success"
                    : step.status === RunStatus.Failed
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
                  <span className="text-error ml-2">{String(step.error)}</span>
                )}
                {/* Show retry badge if step was retried (info in output) */}
                {(() => {
                  const attempts = step.output && Number((step.output as Record<string, unknown>)["attempts"]);
                  return attempts && attempts > 1 ? (
                    <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                      <RotateCcw size={10} className="inline mr-0.5 -mt-0.5" />
                      {attempts} attempts
                    </span>
                  ) : null;
                })()}
              </div>

              {/* Expanded detail */}
              {expanded === step.id && (
                <div className="mt-2 space-y-2">
                  {step.input && Object.keys(step.input).length > 0 && (() => {
                    const extracted = extractToolCode(step.action, step.input)
                    if (extracted) {
                      const otherArgs = Object.fromEntries(
                        Object.entries(step.input).filter(([k]) => k !== extracted.field)
                      )
                      return (
                        <div className="space-y-1">
                          <span className="text-[13px] text-text-muted uppercase tracking-wide">Input</span>
                          {Object.keys(otherArgs).length > 0 && (
                            <JsonViewer value={otherArgs} label="args" defaultExpandDepth={2} maxHeight={160} />
                          )}
                          <CodeBlock code={extracted.code} lang={extracted.lang} maxHeight={180} />
                        </div>
                      )
                    }
                    return (
                      <div>
                        <span className="text-[13px] text-text-muted uppercase tracking-wide">Input</span>
                        <JsonViewer value={step.input} label="input" defaultExpandDepth={2} maxHeight={180} />
                      </div>
                    )
                  })()}
                  {step.output && Object.keys(step.output).length > 0 && (
                    <div>
                      <span className="text-[13px] text-text-muted uppercase tracking-wide">Output</span>
                      <div className="mt-1">
                        <ToolStepOutput output={step.output} maxHeight={260} />
                      </div>
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

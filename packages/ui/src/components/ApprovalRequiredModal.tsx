/**
 * ApprovalRequiredModal — operator decision surface for blocked tool calls.
 *
 * Opens on authoritative `approval.required` SSE from finalize (includes approvalId).
 * The bell notification keeps the same Approve / Deny actions as durable backup.
 */

import { AlertTriangle, ShieldCheck, ShieldX, X } from "lucide-react"
import { useState } from "react"
import type { JSX } from "react"
import { api } from "../api"
import { JsonViewer } from "./JsonViewer"
import { RunStatus } from "../enums"
import { useStore, type PendingToolApproval } from "../store"
import { modalOverlayClass, MODAL_SURFACE_CLASS } from "../widgets/entity-registry/modal-overlay"

function formatArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!args || Object.keys(args).length === 0) return null
  return args
}

export function ApprovalRequiredModal(): JSX.Element | null {
  const pending = useStore((s) => s.pendingToolApproval)
  const open = useStore((s) => s.approvalModalOpen)
  const setApprovalModalOpen = useStore((s) => s.setApprovalModalOpen)
  const clearPending = useStore((s) => s.clearPendingToolApproval)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const upsertRun = useStore((s) => s.upsertRun)
  const markNotificationRead = useStore((s) => s.markNotificationRead)

  const [busy, setBusy] = useState<"approve" | "deny" | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!pending || !open) return null

  function dismiss(): void {
    if (busy) return
    setApprovalModalOpen(false)
  }

  async function resolve(decision: "approve" | "deny"): Promise<void> {
    if (!pending?.approvalId) {
      setError("Approval record is not ready yet — try again from the notification bell in a moment.")
      return
    }
    setBusy(decision)
    setError(null)
    try {
      if (decision === "approve") {
        const result = await api.approveRunToolStep(pending.approvalId)
        if (result.resumedRunId) {
          setActiveRun(result.resumedRunId)
          upsertRun({ id: result.resumedRunId, status: RunStatus.Running })
        } else {
          upsertRun({ id: result.runId, status: RunStatus.WaitingForApproval })
        }
      } else {
        await api.denyRunToolStep(pending.approvalId)
        upsertRun({ id: pending.runId, status: RunStatus.Cancelled })
      }
      if (pending.notificationId) {
        markNotificationRead(pending.notificationId)
        api.markNotificationRead(pending.notificationId).catch(() => {})
      }
      clearPending()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className={modalOverlayClass("focus", { zIndexClass: "z-[70]" })}
      onClick={dismiss}
    >
      <div
        className={`${MODAL_SURFACE_CLASS} policy-editor-modal w-[min(640px,calc(100vw-1.5rem))] max-h-[min(88vh,calc(100dvh-1rem))] flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-modal-title"
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <AlertTriangle size={22} className="text-warning shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h2 id="approval-modal-title" className="text-lg font-semibold text-text">
                Tool approval required
              </h2>
              <p className="text-sm text-text-muted mt-1 leading-relaxed">
                A governance policy blocked <code className="font-mono text-text">{pending.toolName}</code>.
                Approve once to let this run continue, or deny to cancel it.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3"
            onClick={dismiss}
            aria-label="Dismiss"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
          <Detail label="Run" value={pending.runId} mono />
          {pending.policyName && (
            <Detail label="Policy" value={pending.policyName} mono />
          )}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">
              Reason
            </div>
            <p className="text-sm text-text leading-relaxed whitespace-pre-wrap select-text">
              {pending.reason}
            </p>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">
              Tool arguments
            </div>
            {formatArgs(pending.args) ? (
              <JsonViewer value={formatArgs(pending.args)!} label="arguments" defaultExpandDepth={2} maxHeight={240} />
            ) : (
              <p className="text-sm text-text-muted italic">(no arguments)</p>
            )}
          </div>
          {error && (
            <p className="text-sm text-error">{error}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-border-subtle shrink-0">
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-lg text-text-muted hover:text-text hover:bg-overlay-2 disabled:opacity-50"
            disabled={!!busy}
            onClick={dismiss}
          >
            Decide later
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-error/30 text-error hover:bg-error/10 disabled:opacity-50"
            disabled={!!busy}
            onClick={() => void resolve("deny")}
          >
            <ShieldX size={16} />
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-50"
            disabled={!!busy}
            onClick={() => void resolve("approve")}
          >
            <ShieldCheck size={16} />
            {busy === "approve" ? "Approving…" : "Approve & resume"}
          </button>
        </div>
      </div>
    </div>
  )
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
        {label}
      </div>
      <div className={`text-sm text-text select-text ${mono ? "font-mono break-all" : ""}`}>
        {value}
      </div>
    </div>
  )
}

export function pendingApprovalFromEvent(data: Record<string, unknown>): PendingToolApproval {
  return {
    approvalId: (data["approvalId"] as string | undefined) ?? null,
    runId: data["runId"] as string,
    stepId: (data["stepId"] as string | undefined) ?? "",
    toolName: (data["toolName"] as string | undefined) ?? "unknown",
    reason: (data["reason"] as string | undefined) ?? "Policy requires approval",
    policyName: (data["policyName"] as string | undefined) ?? undefined,
    args: (data["args"] as Record<string, unknown> | undefined) ?? undefined,
    notificationId: null,
  }
}

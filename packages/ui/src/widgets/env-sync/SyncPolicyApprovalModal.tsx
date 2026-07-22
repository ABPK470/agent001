/**
 * Sync policy approval — Env Sync path when Policies require confirmation.
 */

import { AlertTriangle, ShieldCheck, ShieldX, X } from "lucide-react"
import { useState, type JSX } from "react"
import { api } from "../../client/index"
import { modalOverlayClass, MODAL_SURFACE_CLASS } from "../entity-registry/modal-overlay"
import { ACTION_BTN, TEXT_BTN } from "../entity-registry/chrome"

export type SyncPolicyPending = {
  approvalId: string
  toolName: string
  reason: string
  policyName?: string
  /** Retry after approve (preview or execute). */
  onApproved: () => void
}

export function SyncPolicyApprovalModal({
  pending,
  onClose,
}: {
  pending: SyncPolicyPending
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function resolve(decision: "approve" | "deny"): Promise<void> {
    setBusy(decision)
    setError(null)
    try {
      if (decision === "approve") {
        await api.approveSyncPolicyApproval(pending.approvalId)
        onClose()
        pending.onApproved()
      } else {
        await api.denySyncPolicyApproval(pending.approvalId)
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className={modalOverlayClass("focus", { zIndexClass: "z-[70]" })}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-policy-approval-title"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className={`${MODAL_SURFACE_CLASS} w-full max-w-lg flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border-subtle px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2
              id="sync-policy-approval-title"
              className="flex items-center gap-2 text-base font-semibold text-text"
            >
              <AlertTriangle size={18} className="text-warning" />
              Approval required
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Policies require confirmation before{" "}
              <code className="font-mono text-text">{pending.toolName}</code>.
            </p>
          </div>
          <button
            type="button"
            className={`${TEXT_BTN} !p-1.5`}
            aria-label="Close"
            disabled={Boolean(busy)}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 px-5 py-4 text-sm text-text-muted">
          <p className="leading-relaxed text-text">{pending.reason}</p>
          {pending.policyName && (
            <p className="font-mono text-xs text-text-faint">Policy: {pending.policyName}</p>
          )}
          {error && <p className="text-error">{error}</p>}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            className={TEXT_BTN}
            disabled={Boolean(busy)}
            onClick={() => void resolve("deny")}
          >
            <ShieldX size={14} /> Deny
          </button>
          <button
            type="button"
            className={ACTION_BTN}
            disabled={Boolean(busy)}
            onClick={() => void resolve("approve")}
          >
            <ShieldCheck size={14} /> {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        </footer>
      </div>
    </div>
  )
}

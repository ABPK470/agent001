/**
 * AdminLoginModal — fallback admin gate.
 *
 * Triggered by Ctrl+Shift+A. Useful when the UPN-whitelist auto-admin
 * isn't available (e.g. running locally without the welcome modal, or
 * in case someone spoofed your UPN in their welcome modal). Posts to
 * /api/admin/login which sets a signed admin cookie. 503 means
 * MIA_ADMIN_PASSWORD isn't set on the server.
 */

import { useState } from "react"

export interface AdminLoginModalProps {
  onClose: () => void
  onSuccess: () => void
}

export function AdminLoginModal({ onClose, onSuccess }: AdminLoginModalProps) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (res.status === 503) { setError("Admin password is not configured on the server."); return }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Wrong password" })) as { error?: string }
        setError(body.error ?? `HTTP ${res.status}`); return
      }
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl bg-bg border border-border shadow-2xl p-6">
        <h2 className="text-lg font-semibold text-text mb-1">Admin login</h2>
        <p className="text-sm text-text-muted mb-4">Fallback gate. Use only if the UPN whitelist isn't reaching us.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Admin password"
          autoFocus
          className="w-full px-3 py-2 rounded-lg bg-overlay-2 border border-border-subtle text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono"
        />
        {error && <p className="mt-3 text-[13px] text-error">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-text-muted hover:text-text">Cancel</button>
          <button type="submit" disabled={busy} className="px-4 py-1.5 rounded-lg bg-accent text-bg text-sm font-semibold hover:bg-accent/90 disabled:opacity-50">
            {busy ? "Checking..." : "Unlock"}
          </button>
        </div>
      </form>
    </div>
  )
}

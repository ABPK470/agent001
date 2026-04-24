/**
 * WelcomeModal — first-visit identity capture.
 *
 * Asks the user for a display name and UPN/email. NOT authentication —
 * the server uses these only for audit-trail tagging and admin lookup.
 * Auto-admin (UPN whitelist) and the optional admin password are the
 * actual trust mechanisms.
 *
 * Submit posts to /api/me which sets a signed cookie. Refreshes useMe.
 */

import { useState } from "react"

export interface WelcomeModalProps {
  onSubmit: (displayName: string, upn: string) => Promise<void>
}

export function WelcomeModal({ onSubmit }: WelcomeModalProps) {
  const [displayName, setDisplayName] = useState("")
  const [upn, setUpn] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!displayName.trim()) { setError("Display name is required"); return }
    if (upn && /\s/.test(upn)) {
      setError("UPN must not contain whitespace"); return
    }
    setBusy(true); setError(null)
    try { await onSubmit(displayName.trim(), upn.trim()) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-bg border border-white/10 shadow-2xl p-6">
        <h2 className="text-lg font-semibold text-text mb-1">Welcome to Agent001</h2>
        <p className="text-sm text-text-muted mb-5">
          Tell us who you are so your runs and audit trail are labelled correctly.
          This is self-declared and used only for in-app display, not authentication.
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-[13px] text-text-muted block mb-1.5">Display name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Joe Smith"
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="text-[13px] text-text-muted block mb-1.5">UPN / email <span className="text-text-muted/60">(optional)</span></label>
            <input
              type="text"
              value={upn}
              onChange={(e) => setUpn(e.target.value)}
              placeholder="joe.smith@domain.com or admin"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
            />
            <p className="text-[12px] text-text-muted mt-1">
              Whitelisted UPNs (set by the admin via <code className="font-mono">AGENT001_ADMIN_UPNS</code>) get the full UI automatically.
            </p>
          </div>
        </div>
        {error && (
          <p className="mt-3 text-[13px] text-red-400">{error}</p>
        )}
        <div className="mt-5 flex justify-end">
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-accent text-bg text-sm font-semibold hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Continue"}
          </button>
        </div>
      </form>
    </div>
  )
}

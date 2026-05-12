/**
 * AdminLogin — fallback admin auth (Ctrl+Shift+A) when UPN whitelist
 * isn't available. Mirrors the contract from classic UI.
 */

import { useEffect, useRef, useState } from "react"

interface Props {
  onClose: () => void
  onSubmit: (password: string) => Promise<void>
}

export function AdminLogin({ onClose, onSubmit }: Props) {
  const [pw, setPw] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  async function submit() {
    if (!pw) { setErr("password required"); return }
    setBusy(true); setErr(null)
    try { await onSubmit(pw) } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9100,
        background: "rgba(0,0,0,0.85)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 440,
          background: "var(--bg)",
          border: "1px solid var(--divider-strong)",
          padding: 22,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
          <span style={{ color: "var(--fg)", letterSpacing: "0.12em" }}>ADMIN LOGIN</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{ color: "var(--fg-mute)", cursor: "pointer", fontSize: "var(--fs-sm)" }}
          >x</button>
        </div>

        <label style={{ display: "block" }}>
          <span style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", letterSpacing: "0.14em" }}>PASSWORD</span>
          <input
            ref={ref}
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
            style={{
              display: "block", width: "100%", marginTop: 6,
              padding: "6px 0 8px 0",
              fontSize: 16,
              color: "var(--fg)",
              borderBottom: "1px solid var(--divider-strong)",
            }}
          />
        </label>

        {err ? (
          <p style={{ color: "var(--c-error)", fontSize: "var(--fs-sm)", margin: "12px 0 0 0" }}>! {err}</p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 22 }}>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            style={{
              color: "var(--fg)",
              background: "var(--bg-soft)",
              border: "1px solid var(--divider-strong)",
              padding: "8px 18px",
              fontSize: "var(--fs-sm)",
              letterSpacing: "0.12em",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >AUTHENTICATE →</button>
        </div>
      </div>
    </div>
  )
}

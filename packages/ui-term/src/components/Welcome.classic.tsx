/**
 * Welcome — identity capture.
 *
 * Shown first on fresh visit (before animation) and directly on logout.
 * After submit succeeds, calls onReady() which triggers the animation.
 *
 * Single source of truth.
 * packages/ui/src/components/WelcomeModal.tsx re-exports this as WelcomeModal.
 */

import { useEffect, useRef, useState } from "react"

export interface WelcomeProps {
  onSubmit: (displayName: string, upn: string) => Promise<void>
  onReady:  () => Promise<void>
}

const BG     = "var(--bg)"
const FG     = "#e4e4e7"
const DIM    = "#52525b"
const ACCENT = "#d8b4fe"
const ERR    = "#f87171"
const FONT   = '"JetBrains Mono","SFMono-Regular",Consolas,Menlo,monospace'
const FS     = 16

function genSuffix(): string {
  const arr = new Uint8Array(2)
  crypto.getRandomValues(arr)
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("")
}
const SESSION_SUFFIX = genSuffix()

type Step = "name" | "upn" | "submitting" | "exiting"

// The logo SVG inlined with blinking eyes
const Logo = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 14"
    shapeRendering="crispEdges"
    width={40}
    height={28}
    style={{ display: "block", marginBottom: 40 }}
  >
    {/* ears — dimmer than the head */}
    <rect x="0" y="3" width="3" height="8" fill="#7b6fc7b8" />
    <rect x="17" y="3" width="3" height="8" fill="#7b6fc7b8" />
    {/* head body with eye-socket cutouts */}
    <path
      fill="#7B6FC7"
      fillRule="evenodd"
      d="M3 0 H17 V14 H3 Z M3 5 H7 V9 H3 Z M13 5 H17 V9 H13 Z"
    />
    <g className="mia-logo-eye">
      <rect className="logo-eye-open" x="3" y="5" width="4" height="4" />
      <rect className="logo-eye-lid" x="3" y="5" width="4" height="4" />
    </g>
    <g className="mia-logo-eye mia-logo-eye--r">
      <rect className="logo-eye-open" x="13" y="5" width="4" height="4" />
      <rect className="logo-eye-lid" x="13" y="5" width="4" height="4" />
    </g>
  </svg>
);

export function Welcome({ onSubmit, onReady }: WelcomeProps) {
  const [step, setStep]       = useState<Step>("name")
  const [draft, setDraft]     = useState("")
  const [nameVal, setNameVal] = useState("")
  const [err, setErr]         = useState<string | null>(null)
  const [doneName, setDoneName] = useState<string | null>(null)
  const inputRef              = useRef<HTMLInputElement>(null)

  // Autofocus immediately — no click needed. Use timeout=0 (next microtask)
  // so the DOM is fully painted before we steal focus.
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    if (step === "upn") inputRef.current?.focus()
  }, [step])

  async function commit(name: string, upn: string) {
    const uniqueName = `${name} #${SESSION_SUFFIX}`
    setStep("submitting")
    try {
      await onSubmit(uniqueName, upn)
      setDoneName(name)
      setStep("exiting")  // triggers CRT collapse animation
      await new Promise<void>((r) => window.setTimeout(r, 520))  // match animation duration
      await onReady()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setStep("upn")
    }
  }

  function onEnter() {
    const v = draft.trim()
    setErr(null)
    if (step === "name") {
      if (!v) { setErr("name required"); return }
      setNameVal(v)
      setDraft("")
      setStep("upn")
    } else if (step === "upn") {
      setDraft("")
      void commit(nameVal, v)
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9000,
      background: BG, fontFamily: FONT, color: FG,
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      ...(step === "exiting" ? {
        animation: "a001-login-exit 520ms linear forwards",
        willChange: "transform, opacity, filter",
      } : {}),
    }}>
      <div style={{ width: 400, maxWidth: "90vw" }}>

        <Logo />

        {doneName ? (
          /* success flash before animation starts */
          <p style={{ fontSize: FS, color: ACCENT, margin: 0 }}>
            welcome, {doneName}.
          </p>
        ) : (
          <>
            {/* locked name row shown while on upn step */}
            {(step === "upn" || step === "submitting") && (
              <div style={{
                fontSize: FS, color: FG, opacity: 0.35,
                marginBottom: 10,
              }}>
                {nameVal}
              </div>
            )}

            {/* active input — bare underline, autofocused */}
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              placeholder={
                step === "name"       ? "name"        :
                step === "submitting" ? "saving…"     :
                                        "access code"
              }
              onChange={(e) => { setDraft(e.target.value); if (err) setErr(null) }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); onEnter() }
              }}
              disabled={step === "submitting"}
              spellCheck={false}
              autoComplete="off"
              style={{
                display: "block", width: "100%",
                background: "transparent", border: 0,
                borderBottom: `1px solid ${DIM}`,
                outline: "none", color: FG,
                fontFamily: FONT, fontSize: FS,
                padding: "6px 0", caretColor: ACCENT,
                boxSizing: "border-box",
              }}
            />

            {/* error or upn hint — no hint on name step */}
            <div style={{ marginTop: 12, fontSize: 11, minHeight: "1.2em", color: DIM }}>
              {err
                ? <span style={{ color: ERR }}>! {err}</span>
                : step === "upn"
                  ? "leave blank to skip"
                  : null
              }
            </div>
          </>
        )}

      </div>

      <style>{`
        input::placeholder { color: ${DIM}; opacity: 1; }
        /* Underline brightens to accent when the field is focused — clear "ready" signal */
        input:focus { border-bottom-color: ${ACCENT} !important; transition: border-bottom-color 120ms ease; }
        /* CRT power-off: form holds, then rapidly squishes to a bright line, then fades */
        @keyframes a001-login-exit {
          0%   { transform: scaleY(1);    opacity: 1; filter: brightness(1);   }
          55%  { transform: scaleY(1);    opacity: 1; filter: brightness(1.3); }
          82%  { transform: scaleY(0.02); opacity: 1; filter: brightness(2.8); }
          90%  { transform: scaleY(0.02); opacity: 1; filter: brightness(4);   }
          100% { transform: scaleY(0.02); opacity: 0; filter: brightness(0);   }
        }
      `}</style>
    </div>
  )
}

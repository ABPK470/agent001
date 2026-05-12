/**
 * UI shell switcher chip — twin of `packages/ui-term/src/components/UISwitcher.tsx`.
 * Lives in the classic UI to offer one-click jump to the term shell.
 *
 * Pinned to the bottom-right so it never collides with the classic
 * top-bar (bell, hamburger, identity, admin badge). Styled in the
 * term accent (lavender on near-black) to telegraph the destination.
 */

const KEY = "mia:ui"

function setUiShell(s: "classic" | "term"): void {
  try { window.localStorage.setItem(KEY, s) } catch { /* ignore */ }
}

function urlForShell(target: "classic" | "term"): string {
  const { protocol, hostname, port, pathname } = window.location
  if (port === "5179" && target === "term")    return `${protocol}//${hostname}:5180${pathname}`
  if (port === "5180" && target === "classic") return `${protocol}//${hostname}:5179${pathname}`
  const base = `${protocol}//${hostname}${port ? ":" + port : ""}${pathname}`
  return `${base}?ui=${target}`
}

const ACCENT = "#d8b4fe"     // term-UI lavender
const BG     = "#15151b"     // term-UI bg-soft
const BORDER = "#2a2a33"     // term-UI divider-strong

export function UISwitcher() {
  return (
    <button
      type="button"
      onClick={() => { setUiShell("term"); window.location.assign(urlForShell("term")) }}
      title="Switch to terminal UI (MI:A/term)"
      style={{
        position: "fixed",
        bottom: 14,
        right: 14,
        zIndex: 10000,
        fontFamily: '"JetBrains Mono", "SFMono-Regular", "Consolas", monospace',
        fontSize: 12,
        letterSpacing: "0.06em",
        textTransform: "lowercase",
        color: ACCENT,
        padding: "6px 12px",
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        cursor: "pointer",
        background: BG,
        boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.background = "#1d1d24"
        el.style.borderColor = ACCENT
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.background = BG
        el.style.borderColor = BORDER
      }}
    >
      [ open MI:A/term ]
    </button>
  )
}


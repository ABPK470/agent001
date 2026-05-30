import { LayoutGrid, LogOut } from "lucide-react"
import { useEffect, useState } from "react"
import { TermChat } from "../widgets/TermChat"
import { IntroAsciiField } from "./IntroAsciiField"
import { MiaWordmark } from "./IntroConversation"
import { Logo } from "./Logo"

interface Props {
  connected: boolean
  onOpenPlatform: () => void
  onLogout: () => void
  /** False while the login overlay is still covering this page.
   *  The ASCII layer is always painted underneath — it shares the
   *  noise field's start timestamp with the login overlay's ASCII so
   *  both render identical glyphs at any moment. When `revealed` flips
   *  true the ASCII *carves itself open*: a rounded-rectangle hole
   *  grows from the page centre outward via an animated polygon(evenodd)
   *  clip-path, removing the chat region from the ASCII frame. At the
   *  pill location, a smaller ASCII patch draws itself into a thin
   *  rounded-rectangle outline (same polygon-with-hole trick at small
   *  scale) — the pill literally forms from ASCII. The real pill then
   *  fades in inside that outline and the outline dissolves. */
  revealed?: boolean
}

export function ChatHomePage({ connected, onOpenPlatform, onLogout, revealed = true }: Props) {
  // Latch revealed once true so we never re-veil mid-session.
  const [materialised, setMaterialised] = useState(revealed)
  useEffect(() => {
    if (revealed && !materialised) setMaterialised(true)
  }, [revealed, materialised])

  const stateClass = materialised ? "chathome--revealed" : "chathome--veiled"

  return (
    <div className={`chathome ${stateClass} relative flex h-screen flex-col overflow-hidden text-text`}>
      {/* THE ASCII FRAME — single full-screen ASCII field. clip-path is
          a polygon with an inner hole (evenodd fill-rule). Initially
          the inner hole is a zero-size point at centre, so the field
          covers everything and matches the login overlay's ASCII
          exactly. On reveal the inner hole grows to the chat region's
          bounds, carving the ASCII away from the centre and leaving a
          natural frame around the edges. This is the literal motion:
          the ASCII makes space. */}
      <div className="chathome-frame pointer-events-none absolute inset-0 overflow-hidden">
        <IntroAsciiField />
      </div>

      {/* Foreground — header + chat. Fades in as the frame carve nears
          its final state, so the heading + pill arrive inside the
          newly-cleared space (not on top of still-visible ASCII). */}
      <div className="chathome-content relative z-10 flex h-full min-h-0 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Logo size={30} online={connected} />
            <div className="flex min-w-0 items-center gap-2.5 text-text">
              <MiaWordmark />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenPlatform}
              title="Open platform view"
              aria-label="Open platform view"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-border-subtle bg-panel/72 text-text-muted backdrop-blur transition-colors hover:border-border hover:bg-overlay-hover hover:text-text"
            >
              <LayoutGrid size={17} />
            </button>
            <button
              type="button"
              onClick={onLogout}
              title="Log out"
              aria-label="Log out"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-border-subtle bg-panel/72 text-text-muted backdrop-blur transition-colors hover:border-border hover:bg-overlay-hover hover:text-text"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          <TermChat mode="home" />
        </main>
      </div>

      {/* THE PILL OUTLINE — a small ASCII patch pinned to the exact
          pill rectangle. Its clip-path is the same polygon-evenodd
          shape at small scale, animated so the inner hole grows from
          zero to *almost* the full patch — leaving only a thin ASCII
          ring around the pill rect. That ring is the pill being drawn
          in ASCII. The real pill fades in inside it; then the ring
          itself dissolves outward to nothing. */}
      <div
        aria-hidden="true"
        className="chathome-pill-frame pointer-events-none absolute left-1/2 top-[60%] z-20 h-[120px] w-[min(840px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[28px]"
      >
        <IntroAsciiField />
      </div>
    </div>
  )
}


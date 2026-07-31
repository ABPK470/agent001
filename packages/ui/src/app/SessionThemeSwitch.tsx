import { Monitor, Moon, Sun } from "lucide-react"
import type { ThemeMode } from "../hooks/useTheme"
import { useTheme } from "../hooks/useTheme"
import { SELECT_ACTIVE, SELECT_IDLE, SELECT_TRACK } from "../lib/selection"

const MODES: ThemeMode[] = ["light", "dark", "system"]

function modeIcon(mode: ThemeMode) {
  if (mode === "light") return Sun
  if (mode === "dark") return Moon
  return Monitor
}

/** Compact icon-only theme control for the session header row — MODE segment. */
export function SessionThemeSwitch({ className = "" }: { className?: string } = {}) {
  const { mode, setTheme } = useTheme()

  return (
    <div
      className={[SELECT_TRACK, "h-8", className].filter(Boolean).join(" ")}
      role="group"
      aria-label="Theme"
    >
      {MODES.map((option) => {
        const Icon = modeIcon(option)
        const active = mode === option
        return (
          <button
            key={option}
            type="button"
            onClick={() => setTheme(option)}
            aria-pressed={active}
            aria-label={option}
            title={option}
            className={[
              "control-segment__btn flex h-full w-7 items-center justify-center rounded-md transition-colors",
              active ? SELECT_ACTIVE : SELECT_IDLE,
            ].join(" ")}
          >
            <Icon size={13} strokeWidth={2} />
          </button>
        )
      })}
    </div>
  )
}

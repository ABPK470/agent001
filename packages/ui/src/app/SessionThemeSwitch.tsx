import { Monitor, Moon, Sun } from "lucide-react"
import type { ThemeMode } from "../hooks/useTheme"
import { useTheme } from "../hooks/useTheme"

const MODES: ThemeMode[] = ["light", "dark", "system"]

function modeIcon(mode: ThemeMode) {
  if (mode === "light") return Sun
  if (mode === "dark") return Moon
  return Monitor
}

/** Compact icon-only theme control for the session header row. */
export function SessionThemeSwitch({ className = "" }: { className?: string } = {}) {
  const { mode, setTheme } = useTheme()

  return (
    <div
      className={["inline-flex shrink-0 gap-0.5 p-0.5", className].filter(Boolean).join(" ")}
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
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              active
                ? "bg-overlay-2 text-text"
                : "text-text-muted hover:bg-overlay-hover hover:text-text-secondary",
            ].join(" ")}
          >
            <Icon size={13} strokeWidth={2} />
          </button>
        )
      })}
    </div>
  )
}

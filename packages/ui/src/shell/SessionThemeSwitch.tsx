import { Monitor, Moon, Sun } from "lucide-react"
import type { ThemeMode } from "../hooks/useTheme"
import { useTheme } from "../hooks/useTheme"

const MODES: ThemeMode[] = ["light", "dark", "system"]

function modeIcon(mode: ThemeMode) {
  if (mode === "light") return Sun
  if (mode === "dark") return Moon
  return Monitor
}

export function SessionThemeSwitch() {
  const { mode, setTheme } = useTheme()

  return (
    <div className="px-3 py-2.5">
      <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint">
        Appearance
      </p>
      <div
        className="flex gap-0.5 rounded-lg border border-border-subtle bg-overlay-1 p-0.5"
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
              className={[
                "flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-[11px] font-medium capitalize transition-colors",
                active
                  ? "bg-panel-2 text-text shadow-sm"
                  : "text-text-muted hover:text-text-secondary",
              ].join(" ")}
            >
              <Icon size={12} strokeWidth={2} />
              {option}
            </button>
          )
        })}
      </div>
    </div>
  )
}

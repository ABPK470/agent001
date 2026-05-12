/**
 * ThemeToggle — single-button theme switcher cycling Light → Dark → System.
 *
 * The icon shown reflects the user's chosen mode (not the resolved theme),
 * so "System" always looks like a Monitor icon even when system is dark.
 */

import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "../hooks/useTheme"

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { mode, cycle } = useTheme()

  const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor
  const next = mode === "light" ? "Dark" : mode === "dark" ? "System" : "Light"
  const label = mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System"

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${label} — click to switch to ${next}`}
      aria-label={`Theme: ${label}. Click to switch to ${next}.`}
      className={`flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-text hover:bg-overlay-hover transition-colors ${className}`}
    >
      <Icon size={16} />
    </button>
  )
}

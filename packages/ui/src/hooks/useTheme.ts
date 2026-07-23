/**
 * useTheme — tri-state theme management (Light / Dark / System).
 *
 * State lives in localStorage["mia:theme"] (one of "light" | "dark" |
 * "system", default "system"). The "system" mode resolves via
 * matchMedia("(prefers-color-scheme: light)") and reacts live to OS
 * appearance changes.
 *
 * The resolved theme is reflected on <html data-theme="..."> so the
 * CSS token blocks in index.css flip automatically.
 *
 * The initial paint (before React mounts) is handled by the inline
 * script in index.html — that script writes the SAME data-theme attr
 * using the SAME storage key, so there is no flash on reload.
 */

import { useCallback, useEffect, useState } from "react"

export type ThemeMode = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

const STORAGE_KEY = "mia:theme"

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === "light" || raw === "dark" || raw === "system") return raw
  } catch (err: unknown) { console.error("[mia]", err) }
  return "system"
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode
  if (typeof window === "undefined" || !window.matchMedia) return "dark"
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
}

function apply(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved
}

export function useTheme(): {
  mode: ThemeMode
  resolved: ResolvedTheme
  setTheme: (mode: ThemeMode) => void
  cycle: () => void
} {
  const [mode, setMode] = useState<ThemeMode>(() => readStoredMode())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStoredMode()))

  // React to OS changes when in "system" mode.
  useEffect(() => {
    if (mode !== "system") return
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia("(prefers-color-scheme: light)")
    const handler = () => {
      const next: ResolvedTheme = mql.matches ? "light" : "dark"
      setResolved(next)
      apply(next)
    }
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [mode])

  const setTheme = useCallback((next: ThemeMode) => {
    setMode(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch (err: unknown) { console.error("[mia]", err) }
    const r = resolve(next)
    setResolved(r)
    apply(r)
  }, [])

  // Light → Dark → System → Light → …
  const cycle = useCallback(() => {
    setTheme(mode === "light" ? "dark" : mode === "dark" ? "system" : "light")
  }, [mode, setTheme])

  return { mode, resolved, setTheme, cycle }
}

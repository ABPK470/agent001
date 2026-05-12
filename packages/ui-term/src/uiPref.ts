/**
 * UI shell preference — persists which UI the user wants to boot into.
 *
 * Both the classic dashboard and the term UI read this on mount and offer
 * a small switcher chip (top-right). Switching just re-targets the
 * browser to the other shell's URL/port.
 */

const KEY = "mia:ui"
export type UIShell = "classic" | "term"

export function getUiShell(): UIShell {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === "term" ? "term" : "classic"
  } catch { return "classic" }
}

export function setUiShell(s: UIShell): void {
  try { window.localStorage.setItem(KEY, s) } catch { /* ignore */ }
}

/**
 * Resolve the URL of the OTHER shell, factoring in dev port or production
 * sub-path. In dev, classic = :5179 and term = :5180. In prod, both ship
 * from the same origin and we just append `?ui=…` so a tiny boot page
 * can pick the right bundle.
 */
export function urlForShell(target: UIShell): string {
  const { protocol, hostname, port, pathname } = window.location
  // dev: known port pair
  if (port === "5179" && target === "term")    return `${protocol}//${hostname}:5180${pathname}`
  if (port === "5180" && target === "classic") return `${protocol}//${hostname}:5179${pathname}`
  // prod: same origin, query flag
  const base = `${protocol}//${hostname}${port ? ":" + port : ""}${pathname}`
  return `${base}?ui=${target}`
}

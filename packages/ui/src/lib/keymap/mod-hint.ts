/**
 * OS-aware modifier captions — one source for every kbd chip in the UI.
 *
 * Binding tables store the abstract token `Mod` (or legacy `⌘/Ctrl`).
 * Display always resolves to ⌘ on Apple platforms and Ctrl elsewhere.
 */

export type ModHint = "⌘" | "Ctrl"

/** Abstract mod token in binding / hint tables — never render raw. */
export const MOD = "Mod"

export function detectModHint(): ModHint {
  if (typeof navigator === "undefined") return "Ctrl"
  const platform =
    // Chromium UA-CH when available
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
      ?.platform
    ?? navigator.platform
    ?? ""
  const ua = navigator.userAgent ?? ""
  if (/Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X|Macintosh/i.test(ua)) {
    return "⌘"
  }
  return "Ctrl"
}

/** Resolve one key caption for display. */
export function resolveKeyCaption(key: string, mod: ModHint = detectModHint()): string {
  if (key === MOD || key === "⌘/Ctrl") return mod
  if (key.startsWith(`${MOD}+`)) return `${mod}${key.slice(MOD.length)}`
  if (key.startsWith("⌘/Ctrl")) return `${mod}${key.slice("⌘/Ctrl".length)}`
  return key
}

/** Resolve a key chord list for footers, keymap rows, titles. */
export function resolveKeyCaptions(
  keys: readonly string[],
  mod: ModHint = detectModHint(),
): string[] {
  return keys.map((key) => resolveKeyCaption(key, mod))
}

/** Compact chord for `title` / aria copy — e.g. `⌘\\` or `Ctrl+\\`. */
export function formatModChord(
  rest: string,
  mod: ModHint = detectModHint(),
): string {
  if (mod === "⌘") return `⌘${rest}`
  return `Ctrl+${rest}`
}

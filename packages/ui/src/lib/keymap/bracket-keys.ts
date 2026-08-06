/**
 * Physical `[` / `]` — prefer `code` so layout / toLowerCase cannot miss the chord.
 */

export type BracketDirection = -1 | 1

export function resolveBracketDirection(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
): BracketDirection | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (event.code === "BracketLeft" || event.key === "[") return -1
  if (event.code === "BracketRight" || event.key === "]") return 1
  return null
}

/**
 * Summon footer kbd chips — selection-aware (widget vs Space/Preset).
 */

import { MOD, type KbdHint } from "../../lib/keymap"
import type { SummonItem } from "./summon-items"

export function summonFooterHints(
  item: SummonItem | null,
  opts: { primary: string; hasQuery: boolean },
): readonly KbdHint[] {
  const hints: KbdHint[] = [
    { keys: ["↵"], label: opts.primary },
  ]

  if (item?.kind === "widget") {
    hints.push({ keys: [MOD, "↵"], label: "peek" })
  }

  hints.push(
    { keys: ["↑", "↓"], label: "move" },
    { keys: ["←", "→"], label: "column" },
    { keys: ["Esc"], label: opts.hasQuery ? "clear" : "dismiss" },
  )

  return hints
}

/** Context-bar keep/peek chips — same kbd dialect as the footer. */
export function summonContextHints(item: SummonItem | null): readonly KbdHint[] | null {
  if (item?.kind !== "widget") return null
  return [
    { keys: ["↵"], label: "keeps" },
    { keys: [MOD, "↵"], label: "peeks" },
  ]
}

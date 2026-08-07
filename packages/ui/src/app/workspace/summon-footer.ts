/**
 * Summon footer kbd chips — selection-aware (widget vs Space/Preset).
 */

import { MOD, type KbdHint } from "../../lib/keymap"
import { summonSpaceRemovable, type SummonItem } from "./summon-items"

export function summonApplyLabel(opts: {
  keepCount: number
  removeCount: number
}): string {
  const { keepCount, removeCount } = opts
  if (keepCount > 0 && removeCount > 0) {
    return `apply ${keepCount + removeCount}`
  }
  if (removeCount > 0) return `remove ${removeCount}`
  if (keepCount > 0) return `keep ${keepCount}`
  return "apply"
}

/** Title-case apply verb for the land button. */
export function summonApplyButtonLabel(opts: {
  keepCount: number
  removeCount: number
}): string {
  const label = summonApplyLabel(opts)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function summonFooterHints(
  item: SummonItem | null,
  opts: {
    primary: string
    hasQuery: boolean
    pickableCount?: number
    keepCount?: number
    removeCount?: number
  },
): readonly KbdHint[] {
  const keepCount = opts.keepCount ?? 0
  const removeCount = opts.removeCount ?? 0
  const staged = keepCount + removeCount
  const hints: KbdHint[] = [
    {
      keys: ["↵"],
      label:
        staged > 0
          ? summonApplyLabel({ keepCount, removeCount })
          : opts.primary,
    },
  ]

  if (item?.kind === "widget") {
    hints.push({
      keys: ["Space"],
      label: staged > 0 ? "stage" : "stage",
    })
    if (staged === 0) {
      hints.push({ keys: [MOD, "↵"], label: "peek" })
    }
  }

  if (staged === 0 && summonSpaceRemovable(item)) {
    hints.push({ keys: ["⌫"], label: "delete" })
  }

  hints.push(
    { keys: ["↑", "↓"], label: "move" },
    { keys: ["←", "→"], label: "filter" },
    { keys: ["Tab"], label: "cycle" },
  )

  const pickable = opts.pickableCount ?? 0
  if (!opts.hasQuery && pickable >= 2 && staged === 0) {
    const cap = pickable <= 9 ? `1–${pickable}` : "1–9"
    hints.push({ keys: [cap], label: "tile" })
  }

  hints.push({
    keys: ["Esc"],
    label: staged > 0 ? "clear bag" : opts.hasQuery ? "clear" : "dismiss",
  })

  return hints
}

/** Context-bar keep/peek chips — same kbd dialect as the footer. */
export function summonContextHints(
  item: SummonItem | null,
  opts?: { keepCount?: number; removeCount?: number },
): readonly KbdHint[] | null {
  const keepCount = opts?.keepCount ?? 0
  const removeCount = opts?.removeCount ?? 0
  const staged = keepCount + removeCount
  if (staged > 0) {
    return [
      { keys: ["Space"], label: "stage" },
      {
        keys: ["↵"],
        label: summonApplyLabel({ keepCount, removeCount }),
      },
    ]
  }
  if (item?.kind !== "widget") return null
  return [
    { keys: ["↵"], label: "keeps" },
    { keys: [MOD, "↵"], label: "peeks" },
  ]
}

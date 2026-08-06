import { resolveKeyCaptions, type KbdHint } from "../../lib/keymap"

export type ComposerKbdHint = KbdHint

export function ComposerKbdFooter({
  hints,
}: {
  hints: readonly KbdHint[]
}) {
  return (
    <div className="composer-kbd-footer" aria-hidden>
      {hints.map((hint) => {
        const keys = resolveKeyCaptions(hint.keys)
        return (
          <span key={`${hint.label}:${keys.join("+")}`} className="composer-kbd-footer__hint">
            {keys.map((key) => (
              <kbd key={key} className="composer-kbd">
                {key}
              </kbd>
            ))}
            <span>{hint.label}</span>
          </span>
        )
      })}
    </div>
  )
}

export const COMPOSER_PALETTE_HINTS: readonly KbdHint[] = [
  { keys: ["Tab", "↵"], label: "select" },
  { keys: ["↑", "↓"], label: "navigate" },
  { keys: ["Esc"], label: "dismiss" },
]

export const COMPOSER_RESULT_HINTS: readonly KbdHint[] = [
  { keys: ["Esc"], label: "dismiss" },
]

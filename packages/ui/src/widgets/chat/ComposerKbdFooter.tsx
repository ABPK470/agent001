export type ComposerKbdHint = {
  keys: string[]
  label: string
}

export function ComposerKbdFooter({
  hints,
}: {
  hints: readonly ComposerKbdHint[]
}) {
  return (
    <div className="composer-kbd-footer" aria-hidden>
      {hints.map((hint) => (
        <span key={`${hint.label}:${hint.keys.join("+")}`} className="composer-kbd-footer__hint">
          {hint.keys.map((key) => (
            <kbd key={key} className="composer-kbd">
              {key}
            </kbd>
          ))}
          <span>{hint.label}</span>
        </span>
      ))}
    </div>
  )
}

export const COMPOSER_PALETTE_HINTS: readonly ComposerKbdHint[] = [
  { keys: ["Tab", "↵"], label: "select" },
  { keys: ["↑", "↓"], label: "navigate" },
  { keys: ["Esc"], label: "dismiss" },
]

export const COMPOSER_RESULT_HINTS: readonly ComposerKbdHint[] = [
  { keys: ["Esc"], label: "dismiss" },
]

export function ComposerKbdFooter({
  hints,
}: {
  hints: Array<{ keys: string; label: string }>
}) {
  return (
    <div className="composer-kbd-footer" aria-hidden>
      {hints.map((hint) => (
        <span key={hint.keys} className="composer-kbd-footer__hint">
          <kbd className="composer-kbd">{hint.keys}</kbd>
          <span>{hint.label}</span>
        </span>
      ))}
    </div>
  )
}

export const COMPOSER_PALETTE_HINTS = [
  { keys: "Tab · Enter", label: "complete" },
  { keys: "↑↓", label: "navigate" },
  { keys: "Esc", label: "close" },
] as const

export const COMPOSER_RESULT_HINTS = [{ keys: "Esc", label: "dismiss" }] as const

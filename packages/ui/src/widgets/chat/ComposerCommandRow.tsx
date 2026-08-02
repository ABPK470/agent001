import type { ReactNode } from "react"
import { CommandFlagBadges } from "./CommandFlagBadges"

export function ComposerCommandRow({
  name,
  description,
  flags,
  meta,
  active = false,
  disabled = false,
  unavailableNote,
  interactive = false,
  onSelect,
  onHover,
  id,
  optionRef,
}: {
  name: ReactNode
  description: string
  flags?: string[]
  meta?: string
  active?: boolean
  disabled?: boolean
  unavailableNote?: string
  interactive?: boolean
  onSelect?: () => void
  onHover?: () => void
  id?: string
  optionRef?: React.Ref<HTMLButtonElement>
}) {
  const className = [
    "composer-cmd-row",
    interactive ? "composer-cmd-row--interactive" : "",
    active ? "composer-cmd-row--active" : "",
    disabled ? "composer-cmd-row--disabled" : "",
    disabled && unavailableNote ? "composer-cmd-row--has-status" : "",
    flags && flags.length > 0 ? "composer-cmd-row--has-flags" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const trailing = flags && flags.length > 0
    ? <CommandFlagBadges flags={flags} />
    : meta
      ? <span className="composer-cmd-row__meta">{meta}</span>
      : null

  const content = (
    <>
      <span className="composer-cmd-row__name">{name}</span>
      <span className="composer-cmd-row__desc">{description}</span>
      {trailing}
      {disabled && unavailableNote ? (
        <span className="composer-cmd-row__status">{unavailableNote}</span>
      ) : null}
    </>
  )

  if (!interactive) {
    return (
      <div className={className} role="listitem">
        {content}
      </div>
    )
  }

  return (
    <button
      id={id}
      ref={optionRef}
      type="button"
      role="option"
      aria-selected={active}
      aria-disabled={disabled}
      className={className}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault()
        if (!disabled) onSelect?.()
      }}
      onMouseEnter={onHover}
    >
      {content}
    </button>
  )
}

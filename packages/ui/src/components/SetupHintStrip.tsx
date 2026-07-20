/**
 * SetupHintStrip — persistent “something needs attention” strip.
 *
 * One dialect for widgets and Configuration modals (Entity Registry):
 * edge-to-edge `border-b` + `bg-panel-2`. Warning = action required;
 * muted = informational (no action / Publish not required).
 *
 * Not for transient failures — those stay on ToastStack / ModalToastStack.
 */

import type { LucideIcon } from "lucide-react"
import type { JSX, ReactNode } from "react"

export type SetupHintTone = "warning" | "muted"

export function SetupHintStrip({
  tone = "warning",
  icon: Icon,
  children,
  className = "",
  actions,
}: {
  tone?: SetupHintTone
  icon?: LucideIcon
  children: ReactNode
  /** Extra classes (e.g. denser `px-3` in compact widgets). */
  className?: string
  actions?: ReactNode
}): JSX.Element {
  const toneClass =
    tone === "warning"
      ? "border-warning/40 text-text"
      : "border-border-subtle text-text-muted"

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        "shrink-0 border-b bg-panel-2 px-5 py-2.5 text-sm",
        toneClass,
        className,
      ].join(" ")}
    >
      <div className="flex items-start gap-2.5">
        {Icon ? (
          <Icon
            size={16}
            className={[
              "mt-0.5 shrink-0",
              tone === "warning" ? "text-warning" : "text-text-muted",
            ].join(" ")}
            aria-hidden
          />
        ) : null}
        <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

import type { JSX, ReactNode, Ref } from "react"

export function ReviewDetailPane({
  empty,
  emptyMessage = "Select a step to inspect",
  header,
  sectionCap,
  children,
  className = "",
  scrollRef,
}: {
  empty?: boolean
  emptyMessage?: string
  header?: ReactNode
  sectionCap?: ReactNode
  children?: ReactNode
  className?: string
  scrollRef?: Ref<HTMLDivElement>
}): JSX.Element {
  if (empty) {
    return (
      <div className={`review-detail review-detail--empty flex min-h-0 flex-1 flex-col items-center justify-center px-6 ${className}`.trim()}>
        <div
          ref={scrollRef}
          className="review-detail__scroll min-h-0 w-full"
          tabIndex={0}
          role="region"
          aria-label="Detail"
        >
          <p className="review-empty text-sm text-text-muted text-center">{emptyMessage}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`review-detail flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${className}`.trim()}>
      {header ? (
        <div className="review-detail__header shrink-0 border-b border-border-subtle">{header}</div>
      ) : null}
      <div
        ref={scrollRef}
        className="review-detail__scroll min-h-0 flex-1 overflow-y-auto"
        tabIndex={0}
        role="region"
        aria-label="Detail"
      >
        {sectionCap ? <div className="review-detail__section-cap">{sectionCap}</div> : null}
        {children}
      </div>
    </div>
  )
}

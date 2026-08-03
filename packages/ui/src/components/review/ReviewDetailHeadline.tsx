import type { JSX, ReactNode } from "react"

export function ReviewDetailHeadline({
  primary,
  secondary,
  actions,
  error,
}: {
  primary: ReactNode
  secondary?: ReactNode
  actions?: ReactNode
  error?: ReactNode
}): JSX.Element {
  return (
    <div className="review-detail__headline-wrap px-4 py-3">
      <div className="review-detail__header-top">
        <div className="review-detail__headline min-w-0 flex-1">{primary}</div>
        {actions ? <div className="review-detail__actions shrink-0">{actions}</div> : null}
      </div>
      {secondary ? <div className="review-detail__headline-secondary mt-2">{secondary}</div> : null}
      {error ? <div className="mt-3">{error}</div> : null}
    </div>
  )
}

export function ReviewDetailErrorCallout({
  label = "Error",
  message,
}: {
  label?: string
  message: string
}): JSX.Element {
  return (
    <div className="review-detail__error-callout" title={message}>
      <span className="review-detail__error-label">{label}</span>
      <span className="review-detail__error-text">{message}</span>
    </div>
  )
}

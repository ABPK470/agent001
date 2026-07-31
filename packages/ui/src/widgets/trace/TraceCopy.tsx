import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"

function useCopyFeedback() {
  const [copied, setCopied] = useState(false)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  function copyValue(value: string, e?: { stopPropagation: () => void }) {
    e?.stopPropagation()
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
        setCopied(true)
        clearTimerRef.current = setTimeout(() => {
          setCopied(false)
          clearTimerRef.current = null
        }, 1600)
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  }

  return { copied, copyValue }
}

export function CopyControl({
  value,
  ariaLabel,
  iconOnly = false,
}: {
  value: string
  ariaLabel: string
  /** Icon-only for quiet meta bands — label stays on aria-label. */
  iconOnly?: boolean
}) {
  const { copied, copyValue } = useCopyFeedback()
  return (
    <button
      type="button"
      className={iconOnly ? "trace-copy trace-copy--icon" : "trace-copy"}
      onClick={(e) => copyValue(value, e)}
      aria-label={copied ? "Copied" : ariaLabel}
      title={copied ? "Copied" : ariaLabel}
    >
      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
      {!iconOnly && <span>{copied ? "Copied" : "Copy"}</span>}
    </button>
  )
}

export function IdChip({
  label,
  value,
  tone = "chip",
}: {
  label: string
  value: string
  /** `meta` — plain review-band type (no pill frame). `chip` — bordered badge. */
  tone?: "chip" | "meta"
}) {
  const short =
    tone === "meta" && value.length > 12 ? `${value.slice(0, 8)}…` : value
  return (
    <span
      className={tone === "meta" ? "widget-review-meta__id" : "trace-id"}
      title={value}
    >
      <span
        className={
          tone === "meta" ? "widget-review-meta__id-label" : "trace-id__label"
        }
      >
        {label}
      </span>
      <span
        className={
          tone === "meta"
            ? "widget-review-meta__id-value font-mono"
            : "trace-id__value font-mono"
        }
      >
        {short}
      </span>
      <CopyControl
        value={value}
        ariaLabel={`Copy ${label}`}
        iconOnly={tone === "meta"}
      />
    </span>
  )
}

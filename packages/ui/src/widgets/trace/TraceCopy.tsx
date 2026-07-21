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
      .catch(() => {
        /* ignore */
      })
  }

  return { copied, copyValue }
}

export function CopyControl({
  value,
  ariaLabel,
}: {
  value: string
  ariaLabel: string
}) {
  const { copied, copyValue } = useCopyFeedback()
  return (
    <button
      type="button"
      className="trace-copy"
      onClick={(e) => copyValue(value, e)}
      aria-label={copied ? "Copied" : ariaLabel}
    >
      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  )
}

export function IdChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="trace-id">
      <span className="trace-id__label">{label}</span>
      <span className="trace-id__value font-mono">{value}</span>
      <CopyControl value={value} ariaLabel={`Copy ${label}`} />
    </span>
  )
}

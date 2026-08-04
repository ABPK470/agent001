import { CopyControl as SharedCopyControl } from "../../components/CopyControl"

export { CopyControl } from "../../components/CopyControl"

export function IdChip({
  label,
  value,
  tone = "chip",
}: {
  label: string
  value: string
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
      <SharedCopyControl
        value={value}
        ariaLabel={`Copy ${label}`}
        iconOnly={tone === "meta"}
      />
    </span>
  )
}

import type { JSX } from "react"
import { JsonViewer } from "../JsonViewer"

export function ReviewPayloadBlock({
  value,
  label,
  maxHeight = 420,
  defaultExpandDepth = 2,
}: {
  value: unknown
  label: string
  maxHeight?: number
  defaultExpandDepth?: number
}): JSX.Element {
  return (
    <JsonViewer
      value={value}
      label={label}
      copyable
      embedded
      inline
      defaultExpandDepth={defaultExpandDepth}
      maxHeight={maxHeight}
    />
  )
}

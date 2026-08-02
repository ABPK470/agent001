/**
 * Expandable text in trace — line-based head/tail peek, one scrollport.
 * Optional Copy rail for long system prompts.
 */

import { InlinePeekText } from "../../components/InlinePeekText"
import { CopyControl } from "./TraceCopy"

export function ExpandableText({
  text,
  className,
  copyLabel,
}: {
  text: string
  className: string
  /** @deprecated Char preview — line peek is always used now. */
  previewChars?: number
  /** When set, show Copy in the sticky rail. */
  copyLabel?: string
}) {
  const body = (
    <InlinePeekText
      text={text}
      className={className}
    />
  )

  if (!copyLabel) return body

  return (
    <div className="trace-expand has-rail">
      <div className="trace-expand__main">{body}</div>
      <div className="trace-expand__rail">
        <div className="trace-expand__sticky">
          <CopyControl value={text} ariaLabel={copyLabel} />
        </div>
      </div>
    </div>
  )
}

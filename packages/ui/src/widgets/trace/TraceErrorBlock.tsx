/**
 * Error trace block with line-level pointers for inspector.
 */

import {
  formatErrorLinePointer,
  parseErrorTrace,
} from "../../lib/events/trace-error-parse"

export function TraceErrorBlock({ text, title = "ERROR / EXCEPTION TRACE" }: {
  text: string
  title?: string
}) {
  const parsed = parseErrorTrace(text)
  return (
    <div className="trace-error-block">
      <div className="trace-error-block__title">{title}</div>
      <div className="trace-error-block__headline">{parsed.headline}</div>
      {parsed.lines.length > 0 ? (
        <ul className="trace-error-block__lines">
          {parsed.lines.map((line) => (
            <li key={`${line.lineNumber}-${line.text}`}>
              {formatErrorLinePointer(line)}
            </li>
          ))}
        </ul>
      ) : null}
      <pre className="trace-error-block__trace">{parsed.raw}</pre>
    </div>
  )
}

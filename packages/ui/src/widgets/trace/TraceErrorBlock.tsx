/**
 * Error body for the inspector — no section chrome (parent owns RESULT/ERROR header).
 */

import {
  formatErrorLinePointer,
  parseErrorTrace,
} from "../../lib/events/trace-error-parse"

function restAfterHeadline(raw: string, headline: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === headline) return ""
  const lines = trimmed.split(/\r?\n/)
  if ((lines[0] ?? "").trim() !== headline) return trimmed
  return lines.slice(1).join("\n").replace(/^\s*\n/, "")
}

export function TraceErrorBlock({
  text,
  /** Optional inner label; omit when a parent section already says Error. */
  title,
}: {
  text: string
  title?: string
}) {
  const parsed = parseErrorTrace(text)
  const rest = restAfterHeadline(parsed.raw, parsed.headline)
  const showHeadline = Boolean(parsed.headline) && Boolean(rest)

  return (
    <div className="trace-error-block">
      {title ? <div className="trace-error-block__title">{title}</div> : null}
      {showHeadline ? (
        <div className="trace-error-block__headline">{parsed.headline}</div>
      ) : null}
      {parsed.lines.length > 0 ? (
        <ul className="trace-error-block__lines">
          {parsed.lines.map((line) => (
            <li key={`${line.lineNumber}-${line.text}`}>
              {formatErrorLinePointer(line)}
            </li>
          ))}
        </ul>
      ) : null}
      <pre className="trace-error-block__trace">
        {showHeadline ? rest : parsed.raw.trim() || parsed.raw}
      </pre>
    </div>
  )
}

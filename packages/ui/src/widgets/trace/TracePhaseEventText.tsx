/**
 * Formatted phase timeline event — tool pills, mono durations, labels.
 */

const TOOL_LIST_RE = /^Tools:\s*(.+)$/i
const FINISHED_RE = /^(Finished)\s*(·\s*)(\d[\d.]*\s*ms)$/i
const SUBAGENT_RE = /^(Subagent started:?)\s*(.*)$/i
const IDENT_RE = /\b([a-z][a-z0-9_]+)\b/g

function ToolList({ raw }: { raw: string }) {
  const tools = raw.split(/,\s*/).filter(Boolean)
  return (
    <>
      <span className="trace-phase-timeline__label">Tools:</span>{" "}
      {tools.map((tool, index) => (
        <span key={`${tool}-${index}`}>
          {index > 0 ? ", " : null}
          <span className="trace-phase-timeline__tool-pill font-mono">{tool.trim()}</span>
        </span>
      ))}
    </>
  )
}

function highlightIdentifiers(text: string) {
  const parts: Array<{ kind: "text" | "ident"; value: string }> = []
  let last = 0
  for (const match of text.matchAll(IDENT_RE)) {
    const ident = match[1]!
    const index = match.index ?? 0
    if (index > last) parts.push({ kind: "text", value: text.slice(last, index) })
    if (ident.length >= 4 && ident.includes("_")) {
      parts.push({ kind: "ident", value: ident })
    } else {
      parts.push({ kind: "text", value: ident })
    }
    last = index + ident.length
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) })
  if (parts.length === 0) return text
  return parts.map((part, i) =>
    part.kind === "ident" ? (
      <span key={`${part.value}-${i}`} className="trace-phase-timeline__tool-pill font-mono">
        {part.value}
      </span>
    ) : (
      <span key={`t-${i}`}>{part.value}</span>
    ),
  )
}

export function TracePhaseEventText({ text }: { text: string }) {
  const toolList = text.match(TOOL_LIST_RE)
  if (toolList?.[1]) {
    return <ToolList raw={toolList[1]} />
  }

  const finished = text.match(FINISHED_RE)
  if (finished) {
    return (
      <>
        <span className="trace-phase-timeline__label">{finished[1]}</span>
        {finished[2]}
        <span className="trace-phase-timeline__metric font-mono tabular-nums">
          {finished[3]}
        </span>
      </>
    )
  }

  const subagent = text.match(SUBAGENT_RE)
  if (subagent) {
    return (
      <>
        <span className="trace-phase-timeline__label">{subagent[1]}</span>
        {subagent[2] ? (
          <span className="trace-phase-timeline__detail font-mono">{subagent[2].trim()}</span>
        ) : null}
      </>
    )
  }

  return <span className="trace-phase-timeline__detail">{highlightIdentifiers(text)}</span>
}

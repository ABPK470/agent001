/**
 * Parse error traces for line-level pointers in the inspector.
 */

export type ParsedErrorLine = {
  lineNumber: number
  text: string
}

export type ParsedErrorTrace = {
  headline: string
  lines: ParsedErrorLine[]
  raw: string
}

const AT_LINE_RE = /(?:^|\s)(?:at line|line)\s+(\d+)\s*[:.)-]?\s*(.*)$/gim
const STACK_LINE_RE =
  /^\s*at\s+(?:\S+\s+)?\(?([^():\s][^:]*?):(\d+)(?::(\d+))?\)?\s*$/gm

export function parseErrorTrace(text: string): ParsedErrorTrace {
  const trimmed = text.trim()
  if (!trimmed) {
    return { headline: "Error", lines: [], raw: text }
  }

  const lines: ParsedErrorLine[] = []
  const seen = new Set<number>()

  for (const match of trimmed.matchAll(AT_LINE_RE)) {
    const lineNumber = Number(match[1])
    const snippet = (match[2] ?? "").trim()
    if (!Number.isFinite(lineNumber) || seen.has(lineNumber)) continue
    seen.add(lineNumber)
    lines.push({
      lineNumber,
      text: snippet || `line ${lineNumber}`,
    })
  }

  for (const match of trimmed.matchAll(STACK_LINE_RE)) {
    const lineNumber = Number(match[2])
    const snippet = `${match[1]}:${lineNumber}`
    if (!Number.isFinite(lineNumber) || seen.has(lineNumber)) continue
    seen.add(lineNumber)
    lines.push({ lineNumber, text: snippet })
  }

  const headline = trimmed.split(/\r?\n/)[0]?.trim() ?? "Error"
  return { headline, lines, raw: text }
}

export function formatErrorLinePointer(line: ParsedErrorLine): string {
  return `At line ${line.lineNumber}: ${line.text}`
}

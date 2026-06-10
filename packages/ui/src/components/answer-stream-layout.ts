/**
 * Streaming answer layout — splits an in-progress agent answer into a
 * committed prefix (fully formed blocks safe to render with SmartAnswer)
 * and a volatile tail (prose still arriving, or structured content that
 * should show a skeleton instead of raw markdown / JSON tokens).
 */

export type StreamingRemainderKind = "none" | "prose" | "fenced" | "table"

export interface StreamingAnswerLayout {
  /** Text that is structurally complete and should render formatted immediately. */
  committed: string
  /** Uncommitted tail — may be empty when the buffer ends on a block boundary. */
  remainder: string
  remainderKind: StreamingRemainderKind
  /** Language tag from an open fenced block, when remainderKind === "fenced". */
  fencedLang?: string
}

function countFenceMarkers(text: string): number {
  let count = 0
  let idx = 0
  while ((idx = text.indexOf("```", idx)) >= 0) {
    count++
    idx += 3
  }
  return count
}

function isTableLine(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith("|") && t.includes("|", 1)
}

function isTableSeparator(row: string): boolean {
  return /^\|[\s\-|:]+\|$/.test(row.trim())
}

function parseTableRow(row: string): string[] {
  return row.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|"))
}

function trailingTableLayout(lines: string[]): StreamingAnswerLayout | null {
  let lastNonEmpty = lines.length - 1
  while (lastNonEmpty >= 0 && lines[lastNonEmpty].trim() === "") lastNonEmpty--
  if (lastNonEmpty < 0) return null

  let tableStart = lastNonEmpty
  while (tableStart >= 0 && isTableLine(lines[tableStart])) tableStart--
  tableStart++

  if (tableStart > lastNonEmpty) return null

  const tableLines = lines.slice(tableStart, lastNonEmpty + 1)
  const dataLines = tableLines.filter((l) => !isTableSeparator(l))
  const lastLine = tableLines[tableLines.length - 1] ?? ""
  const looksIncomplete =
    dataLines.length < 2 ||
    !lastLine.trimEnd().endsWith("|") ||
    (dataLines.length >= 2 &&
      parseTableRow(dataLines[0]).length > 0 &&
      dataLines.slice(1).some((row) => {
        const cells = parseTableRow(row)
        return cells.length !== parseTableRow(dataLines[0]).length
      }))

  if (!looksIncomplete) return null

  const committedText = tableStart === 0 ? "" : lines.slice(0, tableStart).join("\n").replace(/\s+$/, "")
  return {
    committed: committedText,
    remainder: lines.slice(tableStart).join("\n"),
    remainderKind: "table",
  }
}

function trailingProseLayout(text: string): StreamingAnswerLayout | null {
  const lastParaBreak = text.lastIndexOf("\n\n")
  if (lastParaBreak <= 0 || lastParaBreak >= text.length - 1) return null

  const afterBreak = text.slice(lastParaBreak + 2)
  if (!afterBreak) return null
  if (afterBreak.startsWith("```")) return null
  if (isTableLine(afterBreak)) return null
  if (/^#{1,3}\s/.test(afterBreak)) return null
  if (/^[-*•]\s/.test(afterBreak)) return null
  if (/^\d+[.)]\s/.test(afterBreak)) return null

  return {
    committed: text.slice(0, lastParaBreak).replace(/\s+$/, ""),
    remainder: afterBreak,
    remainderKind: "prose",
  }
}

export function splitStreamingAnswer(text: string): StreamingAnswerLayout {
  if (!text) return { committed: "", remainder: "", remainderKind: "none" }

  // Open fenced block — never stream raw fence / JSON characters.
  if (countFenceMarkers(text) % 2 === 1) {
    const openIdx = text.lastIndexOf("```")
    const lineStart = openIdx <= 0 ? 0 : text.lastIndexOf("\n", openIdx - 1) + 1
    const firstLine = text.slice(lineStart).split("\n")[0] ?? ""
    return {
      committed: text.slice(0, lineStart).replace(/\s+$/, ""),
      remainder: text.slice(lineStart),
      remainderKind: "fenced",
      fencedLang: firstLine.slice(3).trim() || "text",
    }
  }

  const lines = text.split("\n")
  const tableLayout = trailingTableLayout(lines)
  if (tableLayout) return tableLayout

  const proseLayout = trailingProseLayout(text)
  if (proseLayout) return proseLayout

  return { committed: "", remainder: text, remainderKind: "prose" }
}

export function joinStreamingParts(committed: string, proseTail: string): string {
  if (!committed) return proseTail
  if (!proseTail) return committed
  return `${committed}\n\n${proseTail}`
}

export function parsePartialTable(raw: string): { headers: string[]; rows: string[][] } | null {
  const lines = raw.split("\n").filter((l) => l.trim())
  const dataLines = lines.filter((l) => !isTableSeparator(l))
  if (dataLines.length === 0) return null
  const headers = parseTableRow(dataLines[0])
  if (headers.length === 0) return null
  const rows = dataLines
    .slice(1)
    .map(parseTableRow)
    .filter((r) => r.length === headers.length)
  return { headers, rows }
}

/**
 * Markdown block parser for agent answers.
 * Shared by SmartAnswer and the streaming printer.
 */

export type AnswerBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "bullet-list"; items: string[] }
  | { type: "ordered-list"; items: { num: number; text: string }[] }
  | { type: "command"; command: string; before: string; after: string }
  | { type: "hr" }

function parseCommandLikeItem(text: string): { name: string; detail: string } | null {
  const trimmed = text.trim().replace(/^`|`$/g, "")
  const match = trimmed.match(/^([a-z][a-z0-9_.-]{2,})(?:\s+(.+))?$/)
  if (!match || !match[2]) return null
  const detail = match[2].trim()
  const looksStructured = /=|\bargs?\b|\btable\s*=|\bcolumn\s*=|\bbetween\s*=|\bquery\s*=|\[[^\]]+\]|"[^"]+"/.test(detail)
  return looksStructured ? { name: match[1], detail } : null
}

function cleanupCommandBoundaryText(text: string, side: "before" | "after"): string {
  let cleaned = text.trim()
  if (!cleaned) return ""
  if (side === "before") cleaned = cleaned.replace(/\s*(\*\*|__|`)+\s*$/g, "")
  else cleaned = cleaned.replace(/^\s*(\*\*|__|`)+\s*/g, "")
  return cleaned.trim()
}

export function parseAnswerBlocks(text: string): AnswerBlock[] {
  const lines = text.split("\n")
  const blocks: AnswerBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") { i++; continue }

    if (/^\s*(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[*\s]*|_\s*_\s*_[_\s]*)$/.test(line)) {
      blocks.push({ type: "hr" })
      i++
      continue
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i])
        i++
      }
      i++
      blocks.push({ type: "code", lang, text: codeLines.join("\n") })
      continue
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2] })
      i++
      continue
    }

    if (line.trimStart().startsWith("|") && line.includes("|", 1)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        tableLines.push(lines[i])
        i++
      }
      const isSeparator = (row: string) => /^\|[\s\-|:]+\|$/.test(row.trim())
      const parseRow = (row: string) =>
        row.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|"))
      const dataLines = tableLines.filter((l) => !isSeparator(l))
      if (dataLines.length >= 2) {
        const headers = parseRow(dataLines[0])
        const rows = dataLines.slice(1).map(parseRow).filter((r) => r.length === headers.length)
        blocks.push({ type: "table", headers, rows })
      } else if (dataLines.length === 1) {
        blocks.push({ type: "paragraph", lines: [dataLines[0]] })
      }
      continue
    }

    if (/^[-*•]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*•]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*•]\s+/, ""))
        i++
      }
      blocks.push({ type: "bullet-list", items })
      continue
    }

    if (/^\d+[.)]\s/.test(line)) {
      const items: { num: number; text: string }[] = []
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) {
        const m = lines[i].match(/^(\d+)[.)]\s+(.*)$/)
        items.push({ num: m ? Number(m[1]) : items.length + 1, text: m ? m[2] : lines[i] })
        i++
      }
      blocks.push({ type: "ordered-list", items })
      continue
    }

    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^#{1,3}\s/) &&
      !(lines[i].trimStart().startsWith("|") && lines[i].includes("|", 1)) &&
      !/^[-*•]\s/.test(lines[i]) &&
      !/^\d+[.)]\s/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      const joined = paraLines.join("\n")
      const cmdMatch = joined.match(/`(\w+\s+\w+=\S[^`]*)`/)
      if (cmdMatch) {
        const idx = cmdMatch.index!
        blocks.push({
          type: "command",
          command: cmdMatch[1],
          before: cleanupCommandBoundaryText(joined.slice(0, idx), "before"),
          after: cleanupCommandBoundaryText(joined.slice(idx + cmdMatch[0].length), "after"),
        })
      } else {
        const commandLineIndex = paraLines.findIndex((l) => parseCommandLikeItem(l) !== null)
        if (commandLineIndex >= 0) {
          blocks.push({
            type: "command",
            command: paraLines[commandLineIndex].trim().replace(/^`|`$/g, ""),
            before: cleanupCommandBoundaryText(paraLines.slice(0, commandLineIndex).join("\n"), "before"),
            after: cleanupCommandBoundaryText(paraLines.slice(commandLineIndex + 1).join("\n"), "after"),
          })
        } else {
          blocks.push({ type: "paragraph", lines: paraLines })
        }
      }
    }
  }

  return blocks
}

/**
 * Tool-result compaction helpers — produce concise per-tool summaries
 * with a semantic suffix (symbol list or excerpt) when possible.
 *
 * @module
 */

export function compactToolResult(
  toolName: string,
  filePath: string | null,
  content: string,
): string {
  const lineCount = content.split("\n").length
  const charCount = content.length
  const pathLabel = filePath ? ` ${filePath}` : ""
  const semanticSuffix = buildCompactedSemanticSuffix(filePath, content)

  switch (toolName) {
    case "read_file":
      return `[compacted] read_file${pathLabel}: ${lineCount} lines, ${charCount} chars${semanticSuffix}`
    case "write_file":
      return `[compacted] write_file${pathLabel}: ${lineCount} lines, ${charCount} chars${semanticSuffix}`
    case "replace_in_file":
      return `[compacted] replace_in_file${pathLabel}: replacement applied (${charCount} chars in result)${semanticSuffix}`
    case "run_command": {
      const lines = content.split("\n")
      if (lines.length <= 10) return content
      const head = lines.slice(0, 3).join("\n")
      const tail = lines.slice(-3).join("\n")
      return `[compacted] run_command (${lineCount} lines):\n${head}\n  ... (${lineCount - 6} lines omitted) ...\n${tail}`
    }
    case "list_directory":
      return `[compacted] list_directory${pathLabel}: ${lineCount} entries`
    case "search_files":
      return `[compacted] search_files: ${lineCount} result lines`
    case "browser_check": {
      if (charCount < 1000) return content
      return content.slice(0, 800) + `\n... (${charCount - 800} chars omitted)`
    }
    default:
      if (charCount < 500) return content
      return `[compacted] ${toolName}${pathLabel} (${charCount} chars)${semanticSuffix || `: ${extractCompactExcerpt(content)}`}`
  }
}

export function buildCompactedSemanticSuffix(filePath: string | null, content: string): string {
  const defs = extractDefinitionSummary(content)
  if (defs) return ` — symbols: ${defs}`
  const excerpt = extractCompactExcerpt(content)
  if (!excerpt) return ""
  const label = filePath && /\.(?:json|ya?ml|toml|md|txt|rst|adoc)$/i.test(filePath)
    ? "summary"
    : "excerpt"
  return ` — ${label}: ${excerpt}`
}

export function extractCompactExcerpt(content: string, maxLen = 160): string {
  const firstMeaningfulLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 8 && !/^[/#*\-_=]{3,}$/.test(line))
    ?? ""
  if (!firstMeaningfulLine) return ""
  const normalized = firstMeaningfulLine.replace(/\s+/g, " ")
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized
}

export function extractDefinitionSummary(code: string): string | null {
  const names: string[] = []
  const patterns = [
    /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g,
    /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*def\s+([A-Za-z_][\w]*)\s*\(/g,
    /(?:^|\n)\s*class\s+([A-Za-z_][\w]*)\s*(?:\(|:)/g,
  ]

  for (const re of patterns) {
    let match
    while ((match = re.exec(code)) !== null) {
      if (!names.includes(match[1])) names.push(match[1])
    }
  }
  if (names.length === 0) return null
  if (names.length <= 10) return names.join(", ")
  return names.slice(0, 10).join(", ") + ` (+${names.length - 10} more)`
}

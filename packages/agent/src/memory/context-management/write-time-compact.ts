/**
 * Write-time tool-result compaction.
 *
 * `compactToolResult` (in result-summary.ts) is invoked from
 * `truncateMessages()` only when the *whole* context is over budget —
 * by then the bytes have already been billed to several downstream LLM
 * calls. For a class of tools that are *known* to occasionally produce
 * very large outputs (attachment reads, big shell pipelines, oversized
 * file reads) we summarise eagerly at write-time so the bloated body
 * never re-enters a future LLM round.
 *
 * The agent can always re-fetch the full content via the offset/limit
 * parameters of the originating tool — see `read_attachment` and
 * `read_file` which both accept `offset` + `limit`.
 *
 * Threshold rationale: 16 KB ≈ ~4 K tokens. Below that, the cost of
 * shipping the raw body for a few rounds is cheaper than the recall
 * cost the agent pays when it has to re-call the tool to get the
 * detail back.
 */

const WRITE_TIME_BYTE_THRESHOLD = 16 * 1024

const HEAD_BYTES = 4 * 1024
const TAIL_BYTES = 1 * 1024

/**
 * Tools whose successful results we eagerly summarise when they exceed
 * `WRITE_TIME_BYTE_THRESHOLD`. Picked to match the actual offenders
 * seen in production traces (e.g. `read_attachment` returning entire
 * 4-MB CSVs verbatim).
 */
const EAGER_COMPACT_TOOLS = new Set<string>([
  "read_attachment",
  "import_attachment",
  "read_file",
  "run_command",
  "shell",
  "fetch_url"
])

export function compactAtWriteTime(toolName: string, content: string): string {
  if (!EAGER_COMPACT_TOOLS.has(toolName)) return content
  if (content.length <= WRITE_TIME_BYTE_THRESHOLD) return content

  const head = content.slice(0, HEAD_BYTES)
  const tail = content.slice(-TAIL_BYTES)
  const omittedBytes = content.length - HEAD_BYTES - TAIL_BYTES

  // Tool-specific guidance for fetching the omitted middle.
  const recallHint =
    toolName === "read_attachment"
      ? `re-call read_attachment with offset=${HEAD_BYTES} (and offset=${HEAD_BYTES + Math.floor(omittedBytes / 2)} etc.) to page through the rest`
      : toolName === "import_attachment"
        ? `re-call import_attachment with the same id and stream the file from the sandbox path returned above`
        : toolName === "read_file"
          ? `re-call read_file with startLine/endLine to fetch a specific range`
          : toolName === "run_command" || toolName === "shell"
            ? `re-run with a more specific filter (head/tail/grep) to narrow the output`
            : toolName === "fetch_url"
              ? `re-fetch with a narrower selector or path`
              : `re-call with narrower parameters to fetch the omitted region`

  return [
    head,
    "",
    `[truncated at write time — ${omittedBytes.toLocaleString()} more bytes available; ${recallHint}]`,
    "",
    tail
  ].join("\n")
}

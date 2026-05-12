/**
 * extractCompactionState — walk a slice of messages and synthesise the
 * structured ArtifactCompactionState used by the resume anchor.
 *
 * Tracks per-tool-call metadata so we can correlate write/read pairs
 * across messages and detect repair cycles.
 *
 * @module
 */

import type { ArtifactCompactionState, CompactedFileRecord } from "../context-compaction.js"
import type { Message } from "../../types.js"

/** Look up the file-path argument under any of the common arg key names. */
export function extractFilePath(args: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "file_path", "file", "filename"]) {
    if (typeof args[key] === "string") return args[key] as string
  }
  return null
}

export function extractCompactionState(
  messages: readonly Message[],
  goal: string,
  currentIteration: number,
): ArtifactCompactionState {
  const toolCallCounts: Record<string, number> = {}
  const writeMap = new Map<
    string,
    { writeCount: number; linesAtLastWrite: number; lastWriteMsgIdx: number }
  >()
  const readAfterWrite = new Set<string>()
  const successfulCommands: string[] = []
  const failedCommands: string[] = []
  let toolRoundCount = 0
  let repairEpisodes = 0
  let lastAssistantText: string | undefined
  let lastErrorSummary: string | undefined

  const toolCallMeta = new Map<
    string,
    { name: string; path: string | null; command: string | null; msgIdx: number }
  >()

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        toolRoundCount++
        for (const tc of m.toolCalls) {
          toolCallCounts[tc.name] = (toolCallCounts[tc.name] ?? 0) + 1
          const args = tc.arguments as Record<string, unknown>
          const path = extractFilePath(args)
          const command = typeof args.command === "string" ? (args.command as string) : null
          toolCallMeta.set(tc.id, { name: tc.name, path, command, msgIdx: i })

          if (tc.name === "write_file" || tc.name === "replace_in_file") {
            if (path) {
              const existing = writeMap.get(path)
              const content = typeof args.content === "string" ? (args.content as string) : ""
              const lineCount = content
                ? content.split("\n").length
                : (existing?.linesAtLastWrite ?? 0)
              writeMap.set(path, {
                writeCount: (existing?.writeCount ?? 0) + 1,
                linesAtLastWrite: lineCount,
                lastWriteMsgIdx: i,
              })
            }
          } else if (tc.name === "read_file") {
            if (path) {
              const writeInfo = writeMap.get(path)
              if (writeInfo && i > writeInfo.lastWriteMsgIdx) {
                readAfterWrite.add(path)
              }
            }
          }
        }
      }
      if (m.content) {
        const text = m.content.trim()
        if (text) {
          lastAssistantText = text.length > 300 ? text.slice(0, 300) + "..." : text
        }
      }
      continue
    }

    if (m.role === "tool" && m.toolCallId && m.content) {
      const meta = toolCallMeta.get(m.toolCallId)
      if (!meta) continue
      const content = m.content

      if (
        /^Error:|\b(?:failed|exception|traceback|enoent|eacces|permission denied)\b/i.test(content)
        && !/\bno errors\b/i.test(content)
      ) {
        const short = content.slice(0, 150).replace(/\s+/g, " ")
        lastErrorSummary = `${meta.name}${meta.path ? ` ${meta.path}` : ""}: ${short}`
      }

      if (meta.name === "run_command" && meta.command) {
        const isSuccess =
          /\b(?:passed|success|0 failed|build succeeded|compiled|done)\b/i.test(content)
          && !/\b(?:error|failed|exception)\b/i.test(content)
        const isFailure =
          /\b(?:error|failed|exception|syntax error)\b/i.test(content)
          && !/\bno errors\b|\bno.*failed\b/i.test(content)
        if (isSuccess) {
          successfulCommands.push(meta.command.slice(0, 80))
        } else if (isFailure) {
          failedCommands.push(meta.command.slice(0, 80))
        }
      }
    }
  }

  for (const [path, info] of writeMap) {
    if (info.writeCount > 1 && readAfterWrite.has(path)) {
      repairEpisodes++
    }
  }

  const writtenFiles: CompactedFileRecord[] = []
  for (const [path, info] of writeMap) {
    writtenFiles.push({
      path,
      writeCount: info.writeCount,
      linesAtLastWrite: info.linesAtLastWrite,
      lastVerified: readAfterWrite.has(path),
    })
  }
  writtenFiles.sort((a, b) => a.path.localeCompare(b.path))

  return {
    compactedAtIteration: currentIteration,
    goal,
    completedToolRounds: toolRoundCount,
    toolCallCounts,
    writtenFiles,
    verifiedFiles: writtenFiles.filter(f => f.lastVerified).map(f => f.path),
    successfulCommands: [...new Set(successfulCommands)].slice(0, 10),
    failedCommands: [...new Set(failedCommands)].slice(0, 5),
    pendingNextAction: lastAssistantText,
    repairEpisodes,
    lastErrorSummary,
  }
}

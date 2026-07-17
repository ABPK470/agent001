/**
 * File-stall nudges (excessive reads).
 *
 * @module
 */

import { MessageRole } from "../../../domain/enums/message.js"
import * as log from "../../../internal/index.js"
import type { PostRoundContext } from "../post-round/index.js"

export function processExcessiveReadFiles(ctx: PostRoundContext): void {
  const { roundToolCalls, state, messages, config, iteration } = ctx

  const reads = roundToolCalls.filter((tc) => tc.name === "read_file" && !tc.isError)
  if (reads.length === 0) return

  const roundHadWrite = roundToolCalls.some(
    (tc) => !tc.isError && (tc.name === "write_file" || tc.name === "replace_in_file")
  )
  if (roundHadWrite) {
    state.cumulativeReadFileHistory.clear()
  }

  const pathsRead = reads.map((tc) => {
    const p = String(tc.args["path"] ?? "")
    return p.split(/[\\/]/).pop() ?? p
  })

  for (const basename of pathsRead) {
    state.cumulativeReadFileHistory.set(basename, (state.cumulativeReadFileHistory.get(basename) ?? 0) + 1)
  }

  if (reads.length > 4) {
    const uniqueFiles = new Set(pathsRead)
    const msg =
      `OVER-READING: You called read_file ${reads.length} times this iteration` +
      (uniqueFiles.size < reads.length
        ? ` (reading ${reads.length - uniqueFiles.size} duplicate file(s): ${pathsRead
            .filter((p, i) => pathsRead.indexOf(p) !== i)
            .join(", ")})`
        : "") +
      `. Stop re-reading files — you already have the content you need. ` +
      `Do NOT read absolute sandbox/temp paths; use relative project paths only. ` +
      `Proceed to write your next change.`
    messages.push({ role: MessageRole.System, content: msg, section: "history" })
    config.onNudge?.({ tag: "excessive-reads", message: msg, iteration })
    if (config.verbose)
      log.logError(`Excessive reads: ${reads.length} read_file calls at iteration ${iteration}`)
    return
  }

  const overReadFiles = [...state.cumulativeReadFileHistory.entries()]
    .filter(([, count]) => count > 5)
    .map(([basename]) => basename)

  if (overReadFiles.length > 0) {
    const msg =
      `REPEATED READS WITHOUT PROGRESS: You have read ${overReadFiles.map((f) => `"${f}"`).join(", ")} ` +
      `more than 5 times across iterations without writing anything. ` +
      `Reading the same file repeatedly via different paths (relative vs absolute /var/folders/...) ` +
      `gives you the same truncated view every time. ` +
      `You already have all the file content available. Stop reading and write your fix now.`
    messages.push({ role: MessageRole.System, content: msg, section: "history" })
    config.onNudge?.({ tag: "excessive-reads-cumulative", message: msg, iteration })
    if (config.verbose)
      log.logError(`Cumulative excessive reads: ${overReadFiles.join(", ")} at iteration ${iteration}`)
    for (const f of overReadFiles) state.cumulativeReadFileHistory.delete(f)
  }
}

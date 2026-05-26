/**
 * File-stall nudges (coherent repair stall, excessive reads).
 * Extracted from post-round.ts.
 *
 * @module
 */

import { MessageRole } from "../../domain/enums/message.js"
import * as log from "../../internal/index.js"
import type { PostRoundContext } from "../post-round/index.js"

const COHERENT_READ_ONLY_ROUND_LIMIT = 1

export function processCoherentRepairStall(ctx: PostRoundContext): void {
  const { state, roundToolCalls, messages, config, iteration } = ctx
  const ce = state.coherentExecution
  if (!ce) return

  const roundHadWrite = roundToolCalls.some(
    tc => !tc.isError && (tc.name === "write_file" || tc.name === "replace_in_file"),
  )
  if (roundHadWrite) {
    state.coherentRepairReadOnlyRounds = 0
    return
  }

  const roundHadRead = roundToolCalls.some(tc => tc.name === "read_file")
  if (!roundHadRead) return

  state.coherentRepairReadOnlyRounds++
  if (state.coherentRepairReadOnlyRounds < COHERENT_READ_ONLY_ROUND_LIMIT) return

  state.coherentRepairReadOnlyRounds = 0
  const repairFiles = ce.bundle.artifacts.map(a => a.path).join(", ")
  const spinMsg =
    `REPAIR STALL DETECTED: You read files without writing anything in the previous iteration. ` +
    `Stop reading and write the fix NOW.\n` +
    `Files in scope: ${repairFiles}\n` +
    `REQUIRED NEXT ACTION: call write_file (or replace_in_file) to apply the fix. ` +
    `If the write guard is blocking you because a function is missing, include ALL existing functions PLUS the fix in your write. ` +
    `If the issue requires restructuring (e.g. removing an ES module import), restructure now — rewrite the entire affected file.`
  messages.push({ role: MessageRole.System, content: spinMsg, section: "history", hint: true })
  config.onNudge?.({ tag: "coherent-repair-stall", message: spinMsg, iteration })
  if (config.verbose) log.logError(`Coherent repair stall at iteration ${iteration}`)
}


/**
 * Fires a nudge when the agent reads files excessively — either within a
 * single round (>4 reads) OR cumulatively across rounds without writing
 * (sandwich-read pattern: same file re-read via both relative and absolute
 * sandbox path many times while no writes happen).
 *
 * Two thresholds:
 *  - Per-round: > 4 reads in one round → immediate nudge
 *  - Cumulative: any single file (by basename) read > 5 times total → nudge
 *    (resets on any successful write_file / replace_in_file)
 */
export function processExcessiveReadFiles(ctx: PostRoundContext): void {
  const { roundToolCalls, state, messages, config, iteration } = ctx

  const reads = roundToolCalls.filter(tc => tc.name === "read_file" && !tc.isError)
  if (reads.length === 0) return

  // Accumulate cumulative read counts per basename.
  // Reset on write so the counter tracks reads *without writes*.
  const roundHadWrite = roundToolCalls.some(
    tc => !tc.isError && (tc.name === "write_file" || tc.name === "replace_in_file"),
  )
  if (roundHadWrite) {
    // Writing is progress — clear the slate
    state.cumulativeReadFileHistory.clear()
  }

  const pathsRead = reads.map(tc => {
    const p = String(tc.args["path"] ?? "")
    return p.split(/[\\/]/).pop() ?? p
  })

  for (const basename of pathsRead) {
    state.cumulativeReadFileHistory.set(
      basename,
      (state.cumulativeReadFileHistory.get(basename) ?? 0) + 1,
    )
  }

  // Per-round threshold: > 4 reads in this single round
  if (reads.length > 4) {
    const uniqueFiles = new Set(pathsRead)
    const msg =
      `OVER-READING: You called read_file ${reads.length} times this iteration` +
      (uniqueFiles.size < reads.length
        ? ` (reading ${reads.length - uniqueFiles.size} duplicate file(s): ${
            pathsRead.filter((p, i) => pathsRead.indexOf(p) !== i).join(", ")})`
        : "") +
      `. Stop re-reading files — you already have the content you need. ` +
      `Do NOT read absolute sandbox/temp paths; use relative project paths only. ` +
      `Proceed to write your next change.`
    messages.push({ role: MessageRole.System, content: msg, section: "history" })
    config.onNudge?.({ tag: "excessive-reads", message: msg, iteration })
    if (config.verbose) log.logError(`Excessive reads: ${reads.length} read_file calls at iteration ${iteration}`)
    return
  }

  // Cumulative threshold: any file read > 5 times without a write in between
  const overReadFiles = [...state.cumulativeReadFileHistory.entries()]
    .filter(([, count]) => count > 5)
    .map(([basename]) => basename)

  if (overReadFiles.length > 0) {
    const msg =
      `REPEATED READS WITHOUT PROGRESS: You have read ${overReadFiles.map(f => `"${f}"`).join(", ")} ` +
      `more than 5 times across iterations without writing anything. ` +
      `Reading the same file repeatedly via different paths (relative vs absolute /var/folders/...) ` +
      `gives you the same truncated view every time. ` +
      `You already have all the file content available. Stop reading and write your fix now.`
    messages.push({ role: MessageRole.System, content: msg, section: "history" })
    config.onNudge?.({ tag: "excessive-reads-cumulative", message: msg, iteration })
    if (config.verbose) log.logError(`Cumulative excessive reads: ${overReadFiles.join(", ")} at iteration ${iteration}`)
    // Reset so the nudge doesn't fire every iteration after this
    for (const f of overReadFiles) state.cumulativeReadFileHistory.delete(f)
  }
}


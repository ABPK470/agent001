/**
 * Deterministic-tool step execution — direct tool invocation with retry,
 * mkdir-on-EISDIR recovery, and platform-unconfigured short-circuiting.
 *
 * @module
 */

import type { ToolExecFn } from "../pipeline.js"
import { detectPlatformUnconfigured } from "../platform-errors.js"
import type { DeterministicToolStep, PipelineStepResult } from "../types.js"

export async function executeDeterministicStep(
  step: DeterministicToolStep,
  toolExecFn: ToolExecFn,
  t0: number,
  signal?: AbortSignal,
): Promise<PipelineStepResult> {
  const maxRetries = step.maxRetries ?? 2
  let lastError: string | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return {
        name: step.name,
        status: "failed",
        executionState: "failed",
        acceptanceState: "rejected",
        error: "Aborted",
        durationMs: Date.now() - t0,
      }
    }

    try {
      let args = step.args
      if (step.tool === "browser_check" && !args.path && (args.key || args.url)) {
        args = { ...args, path: String(args.key ?? args.url) }
        delete (args as Record<string, unknown>).key
        delete (args as Record<string, unknown>).url
      }

      let output = await toolExecFn(step.tool, args)

      if (
        step.tool === "write_file" &&
        typeof args.path === "string" &&
        /EISDIR|illegal operation on a directory/i.test(output) &&
        String(args.content ?? "").trim().length === 0
      ) {
        const mkdirCmd = `mkdir -p ${JSON.stringify(String(args.path))}`
        const mkdirOutput = await toolExecFn("run_command", { command: mkdirCmd })
        if (!mkdirOutput.startsWith("Error:")) {
          output = `Recovered directory scaffold via run_command: ${mkdirCmd}`
        }
      }

      // Platform-unconfigured short-circuit. Some tools surface the missing
      // config as an "Error: ..." string; others swallow it and embed the
      // diagnosis inside an otherwise success-shaped response (e.g. an
      // mssql-aware tool that returns a narrative explaining the gap). We
      // scan ALL output text — not just the "Error:" prefix — because the
      // verifier-driven repair loop will burn its budget either way.
      const platformInOutput = detectPlatformUnconfigured(output)
      if (platformInOutput) {
        return {
          name: step.name,
          status: "failed",
          executionState: "failed",
          acceptanceState: "rejected",
          error: output,
          failureClass: "platform_unconfigured",
          durationMs: Date.now() - t0,
        }
      }

      if (output.startsWith("Error:")) {
        lastError = output
        continue
      }

      return {
        name: step.name,
        status: "completed",
        executionState: "executed",
        acceptanceState: "accepted",
        output,
        durationMs: Date.now() - t0,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Same short-circuit applies if the tool throws rather than returning a
      // string — e.g. getPool() throwing "MSSQL connection ... not configured".
      const platform = detectPlatformUnconfigured(msg)
      if (platform) {
        return {
          name: step.name,
          status: "failed",
          executionState: "failed",
          acceptanceState: "rejected",
          error: msg,
          failureClass: "platform_unconfigured",
          durationMs: Date.now() - t0,
        }
      }
      lastError = msg
    }
  }

  return {
    name: step.name,
    status: "failed",
    executionState: "failed",
    acceptanceState: "rejected",
    error: lastError ?? "Unknown error",
    durationMs: Date.now() - t0,
  }
}

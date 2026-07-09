/**
 * Canonical plain-text trace export — shared by server streaming and UI.
 * User downloads always originate from this formatter + browser save.
 */

export interface TraceExportRunMeta {
  runId: string
  goal?: string | null
  status?: string | null
  totalTokens?: number | null
  llmCalls?: number | null
}

function indentBlock(text: string, prefix: string): string {
  return String(text ?? "").replace(/\n/g, `\n${prefix}`)
}

/** Format trace JSON entries as a human-readable agent-loop transcript. */
export function formatTraceExportText(
  entries: ReadonlyArray<Record<string, unknown>>,
  meta: TraceExportRunMeta,
): string {
  const lines: string[] = []
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ")
  lines.push(`agent-loop trace  run=${meta.runId}  exported=${ts}`)
  if (meta.goal) lines.push(`goal: ${meta.goal}`)
  lines.push(
    `status: ${meta.status ?? "unknown"}  tokens: ${meta.totalTokens ?? "?"}  llm_calls: ${meta.llmCalls ?? "?"}`,
  )
  lines.push("=".repeat(72))
  lines.push("")

  for (const e of entries) {
    const kind = String(e["kind"] ?? "?")
    const p = "  "
    switch (kind) {
      case "goal":
        lines.push(`GOAL  ${e["text"] ?? ""}`)
        break
      case "system-prompt":
        lines.push(`SYSTEM PROMPT\n${p}${indentBlock(String(e["text"] ?? ""), p)}`)
        break
      case "tools-resolved": {
        const tools = (e["tools"] as Array<{ name?: string }> | undefined) ?? []
        lines.push(`TOOLS  ${tools.length}: ${tools.map((t) => t.name).join(", ")}`)
        break
      }
      case "iteration":
        lines.push(`ITERATION ${e["current"]}/${e["max"]}`)
        break
      case "thinking":
        lines.push(`THINKING\n${p}${indentBlock(String(e["text"] ?? ""), p)}`)
        break
      case "tool-call":
        lines.push(
          `TOOL CALL  ${e["tool"]}  ${e["argsSummary"] ?? ""}\n${p}${indentBlock(String(e["argsFormatted"] ?? ""), p)}`,
        )
        break
      case "tool-result":
        lines.push(`TOOL RESULT\n${p}${indentBlock(String(e["text"] ?? ""), p)}`)
        break
      case "tool-error":
        lines.push(`TOOL ERROR\n${p}${indentBlock(String(e["text"] ?? ""), p)}`)
        break
      case "answer":
        lines.push(`ANSWER\n${p}${indentBlock(String(e["text"] ?? ""), p)}`)
        break
      case "error":
        lines.push(`ERROR\n${p}${indentBlock(String(e["text"] ?? ""), p)}`)
        break
      case "usage":
        lines.push(
          `USAGE  +${e["iterationTokens"] ?? 0} tk · total ${e["totalTokens"] ?? 0} · ${e["llmCalls"] ?? 0} calls`,
        )
        break
      case "llm-request":
        lines.push(
          `LLM REQUEST  ${e["messageCount"] ?? "?"} msgs · ${e["toolCount"] ?? 0} tools  (iter ${e["iteration"] ?? "?"})`,
        )
        break
      case "llm-response":
        lines.push(
          `LLM RESPONSE  ${e["durationMs"] ?? "?"}ms  ${(e["usage"] as { totalTokens?: number } | undefined)?.totalTokens ?? "?"} tok  ${((e["toolCalls"] as unknown[]) ?? []).length} calls`,
        )
        break
      case "planner-decision":
        lines.push(
          `PLANNER  ${e["shouldPlan"] ? "activated" : "skipped"}  score ${Number(e["score"]).toFixed(2)}  route=${e["route"] ?? "-"}`,
        )
        break
      case "planner-step-start":
        lines.push(`STEP  ${e["stepName"]}  ${e["stepType"]}`)
        break
      case "planner-step-end":
        lines.push(
          `STEP END  ${e["stepName"]}  ${e["status"]}${e["durationMs"] != null ? `  ${e["durationMs"]}ms` : ""}`,
        )
        break
      case "planner-sql-quality":
        lines.push(
          `SQL QUALITY  ${e["phase"]}  ${e["toolMode"]}  ${((e["largeObjectRefs"] as Array<{ name: string; count: number }> | undefined)?.map((ref) => `${ref.name}×${ref.count}`).join(" · ") ?? "no-large-refs")}${((e["missingPersistedMirrorCandidates"] as string[] | undefined)?.length ? `  mirror=${(e["missingPersistedMirrorCandidates"] as string[]).join(",")}` : "")}${(e["tempScalarSubqueryCount"] as number | undefined) ? `  temp-subq=${e["tempScalarSubqueryCount"]}` : ""}`,
        )
        break
      case "planner-prompt-budget":
        lines.push(
          `PROMPT BUDGET  ${Number(e["totalBeforeChars"] ?? 0).toLocaleString()} → ${Number(e["totalAfterChars"] ?? 0).toLocaleString()} chars${((e["droppedSections"] as string[] | undefined)?.length ? `  dropped=${(e["droppedSections"] as string[]).join(",")}` : "")}`,
        )
        break
      case "planner-pipeline-start":
        lines.push(`PIPELINE START  attempt ${e["attempt"]}/${e["maxRetries"]}`)
        break
      case "planner-pipeline-end":
        lines.push(`PIPELINE END  ${e["status"]}  ${e["completedSteps"]}/${e["totalSteps"]} steps`)
        break
      case "delegation-start":
        lines.push(`DELEGATE${e["agentName"] ? ` [${e["agentName"]}]` : ""}\n${p}${e["goal"] ?? ""}`)
        break
      case "delegation-iteration":
        lines.push(`DELEGATE ITER ${e["iteration"]}/${e["maxIterations"]}`)
        break
      case "delegation-end":
        lines.push(`DELEGATE END  ${e["status"]}\n${p}${String(e["answer"] ?? e["error"] ?? "").slice(0, 400)}`)
        break
      case "user-input-request":
        lines.push(`ASK USER  ${e["question"] ?? ""}`)
        break
      case "user-input-response":
        lines.push(`USER REPLY  ${e["text"] ?? ""}`)
        break
      case "nudge":
        lines.push(`NUDGE [${e["tag"] ?? ""}]  ${e["message"] ?? ""}`)
        break
      default:
        lines.push(`${kind}  ${JSON.stringify(e).slice(0, 120)}`)
        break
    }
  }

  if (entries.length === 0) lines.push("(no trace entries recorded for this run)")
  return lines.join("\n")
}

export function traceExportFilename(runId: string, ext: "txt" | "json"): string {
  const dateTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return `agent-loop-${dateTag}-${runId.slice(0, 8)}.${ext}`
}

export interface TraceExportThreadMeta {
  threadId: string
  title?: string | null
}

/** Concatenate all run traces in a thread for download. */
export function formatThreadExportText(
  runs: ReadonlyArray<{ meta: TraceExportRunMeta; entries: ReadonlyArray<Record<string, unknown>> }>,
  threadMeta: TraceExportThreadMeta,
): string {
  const lines: string[] = []
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ")
  lines.push(`thread trace  thread=${threadMeta.threadId}  exported=${ts}`)
  if (threadMeta.title) lines.push(`title: ${threadMeta.title}`)
  lines.push(`runs: ${runs.length}`)
  lines.push("=".repeat(72))
  lines.push("")

  for (const run of runs) {
    lines.push(`=== RUN ${run.meta.runId} ===`)
    const body = formatTraceExportText(run.entries, run.meta)
    lines.push(body)
    lines.push("")
  }

  if (runs.length === 0) lines.push("(no runs in this thread)")
  return lines.join("\n")
}

export function threadExportFilename(threadId: string, ext: "txt" | "json"): string {
  const dateTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return `thread-${dateTag}-${threadId.slice(0, 8)}.${ext}`
}

/**
 * Plan v3 Phase 5 — post-run reflection trigger.
 *
 * Fires ONCE after the agent emits a final answer on a data-shaped goal
 * (`decideSections.includeDataPersona === true`). Asks the LLM whether
 * it learned a durable role for any MSSQL object it used or rejected,
 * and writes a `table_verdict` via the `record_table_verdict` tool when
 * the answer is yes.
 *
 * Hard caps:
 *   - 1 LLM call
 *   - 2 tool invocations max (typical: 0–1)
 *   - Tool set: ONLY `record_table_verdict` (no DB access, no shell)
 *   - Best-effort: any failure logs + returns silently
 *
 * The reflection turn is a TOTALLY separate LLM call from the main
 * agent loop. It does not see the chat tape; it sees a compact summary
 * (goal + answer + qnames-seen) so the prompt stays small and the
 * model's attention is focused on the verdict question.
 */

import type { LLMClient, Message, Tool, ToolCall } from "@mia/agent"

/** Minimal shape we need from an agent run's recorded steps. */
export interface ReflectionStep {
  readonly action: string
  readonly input?: unknown
  readonly output?: unknown
}

export interface RunReflectionInput {
  /** Goal text the run answered. */
  goal: string
  /** Final answer text the agent emitted. */
  answer: string
  /** All tool-call steps recorded for this run. */
  steps: readonly ReflectionStep[]
  /** The bound `record_table_verdict` tool (per-run factory output). */
  recordVerdictTool: Tool
  /** LLM client used for the reflection call. */
  llm: LLMClient
  /** Abort signal — usually the parent controller's. */
  signal?: AbortSignal
  /** Per-run id for logging. */
  runId: string
}

export interface RunReflectionResult {
  /** "skipped" — no qnames observed; "no-update" — model declined; "recorded" — at least one verdict written. */
  outcome: "skipped" | "no-update" | "recorded" | "error"
  /** Number of record_table_verdict invocations executed. */
  verdictsRecorded: number
  /** Tool-result text for each invocation (truncated). */
  toolResults: string[]
  /** Free-form note for logs. */
  detail: string
}

// `[a-z][\w]*\.[A-Za-z][\w]*` — matches schema.Table style qnames.
const QNAME_RE = /\b([a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g

const REFLECTION_TOOLS_TO_SCAN: ReadonlySet<string> = new Set([
  "query_mssql",
  "explore_mssql_schema",
  "search_catalog",
  "profile_data",
  "inspect_definition",
  "discover_relationships",
])

/** Extract distinct schema.Table candidates from the steps' inputs+outputs. */
export function extractObservedQnames(steps: readonly ReflectionStep[]): string[] {
  const seen = new Set<string>()
  for (const step of steps) {
    if (!REFLECTION_TOOLS_TO_SCAN.has(step.action)) continue
    const blob = [
      JSON.stringify(step.input ?? {}),
      typeof step.output === "string" ? step.output : JSON.stringify(step.output ?? ""),
    ].join(" ")
    for (const m of blob.matchAll(QNAME_RE)) {
      seen.add(`${m[1]}.${m[2]}`)
    }
  }
  return [...seen].slice(0, 25) // hard cap to keep prompt small
}

const REFLECTION_SYSTEM = `You are a post-run reflection agent. The main agent just answered a database question. Your single job: decide whether ANY of the MSSQL objects it used or rejected this run has a DURABLE role worth recording.

Allowed roles (record only what evidence supports):
- canonical: the right table for the metric (wide UNION view, full history, the BI layer surface).
- subset: narrower scoped view of a canonical (one branch of a UNION, single-product/region).
- staging: load/ETL intermediate; not for analysis.
- archive: historical snapshot; not for live queries.
- rules: mapping/parameter table; contains rules not measured facts.
- unknown: informational only (rarely useful — usually skip instead).

STRICT RULES:
1. Record a verdict ONLY if you have CONCRETE evidence from this run's tool output (row count, view definition fragment, profile_data finding, explicit user feedback). Hearsay = skip.
2. Maximum 2 verdicts per run. Quality over quantity.
3. If nothing is durable, reply exactly: no-update
4. Do NOT speculate. Do NOT record verdicts for tables you didn't touch.
5. Do NOT add commentary alongside tool calls — make the calls, or reply no-update. Nothing else.`

/**
 * Build the user message for the reflection turn. Compact summary of
 * goal + answer + observed qnames, kept under ~2KB total.
 */
function buildReflectionUserMessage(input: RunReflectionInput, qnames: string[]): string {
  const goalLine = input.goal.length > 400 ? input.goal.slice(0, 400) + "\u2026" : input.goal
  const answerLine = input.answer.length > 800 ? input.answer.slice(0, 800) + "\u2026" : input.answer
  const qnamesBlock = qnames.length > 0 ? qnames.join(", ") : "(none extracted)"
  return [
    `GOAL: ${goalLine}`,
    "",
    `FINAL ANSWER: ${answerLine}`,
    "",
    `MSSQL OBJECTS REFERENCED THIS RUN: ${qnamesBlock}`,
    "",
    "Record a table_verdict ONLY for objects in the list above, ONLY with concrete evidence visible in this summary. Otherwise reply: no-update",
  ].join("\n")
}

/**
 * Run the reflection turn. Returns the outcome and any tool results.
 *
 * Errors are caught and logged; this function never throws. The main
 * run has already completed by the time this is invoked.
 */
export async function runReflectionTurn(input: RunReflectionInput): Promise<RunReflectionResult> {
  const qnames = extractObservedQnames(input.steps)
  if (qnames.length === 0) {
    return {
      outcome: "skipped",
      verdictsRecorded: 0,
      toolResults: [],
      detail: "no schema-qualified objects extracted from tool trace",
    }
  }

  const messages: Message[] = [
    { role: "system", content: REFLECTION_SYSTEM },
    { role: "user", content: buildReflectionUserMessage(input, qnames) },
  ]
  const tools: Tool[] = [input.recordVerdictTool]

  let response
  try {
    response = await input.llm.chat(messages, tools, {
      signal: input.signal,
      maxTokens: 400,
      temperature: 0,
    })
  } catch (err) {
    return {
      outcome: "error",
      verdictsRecorded: 0,
      toolResults: [],
      detail: `llm.chat failed: ${(err as Error).message}`,
    }
  }

  const toolCalls: ToolCall[] = (response.toolCalls ?? []).slice(0, 2)

  if (toolCalls.length === 0) {
    const text = (response.content ?? "").trim().toLowerCase()
    return {
      outcome: text.startsWith("no-update") ? "no-update" : "skipped",
      verdictsRecorded: 0,
      toolResults: [],
      detail: text ? `model replied: ${text.slice(0, 120)}` : "no text, no tool calls",
    }
  }

  const toolResults: string[] = []
  let recorded = 0
  for (const call of toolCalls) {
    if (call.name !== input.recordVerdictTool.name) {
      toolResults.push(`(skipped non-allowed tool: ${call.name})`)
      continue
    }
    try {
      const out = await input.recordVerdictTool.execute(call.arguments)
      const text = typeof out === "string" ? out : JSON.stringify(out)
      toolResults.push(text.slice(0, 300))
      if (text.startsWith("record_table_verdict: stored")) recorded++
    } catch (err) {
      toolResults.push(`(execute threw: ${(err as Error).message})`)
    }
  }

  return {
    outcome: recorded > 0 ? "recorded" : "no-update",
    verdictsRecorded: recorded,
    toolResults,
    detail: `${recorded}/${toolCalls.length} verdict(s) recorded`,
  }
}

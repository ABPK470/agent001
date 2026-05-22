// LLM planner fallback for clarification detection.
//
// Phase A.3 of the clarification subsystem. Runs only when:
//   (a) deterministic detectors returned zero findings,
//   (b) the goal is data-shaped (caller's responsibility — usually
//       gated by `decideSections.includeDataPersona` or similar),
//   (c) no clarifications have been resolved yet (round 1–2 only),
//   (d) a CatalogGraph is available — without it the planner has
//       no grounding and would be guessing.
//
// The planner returns the same AmbiguityFinding[] shape as the
// deterministic detectors, tagged with source="llm-planner" so trace
// observers can distinguish.
//
// Pure of catalogue I/O — takes an LLMClient by dependency injection
// so unit tests can pass a fake client without spinning up a real model.

import { MessageRole } from "../domain/enums/message.js"
import type { LLMClient, Message } from "../types.js"
import type {
    AmbiguityFinding,
    AmbiguityKind,
    AmbiguitySeverity,
    ClarifyContext,
} from "./types.js"
import { makeFindingId } from "./types.js"

// ── Public surface ───────────────────────────────────────────────

export interface LlmPlannerOptions {
  /** How many catalog tables to list in the planner prompt. Default: 40. */
  readonly catalogSampleSize?: number
  /** Hard ceiling on findings returned. Default: 4. */
  readonly maxFindings?: number
  /** Max round number at which the planner may still fire. Default: 2. */
  readonly maxRound?: number
  /** AbortSignal forwarded to the LLM call. */
  readonly signal?: AbortSignal
}

/**
 * True iff the planner is permitted to fire under the given gating
 * conditions. Pure check — callers (server orchestrator) should consult
 * this before paying for the LLM call.
 */
export function shouldInvokePlanner(
  ctx: ClarifyContext,
  detectorFindings: readonly AmbiguityFinding[],
  opts: LlmPlannerOptions = {},
): boolean {
  if (detectorFindings.length > 0) return false
  if (!ctx.catalog) return false
  if (ctx.resolved.length > 0) return false
  if (ctx.round > (opts.maxRound ?? 2)) return false
  if (ctx.goal.trim().length < 8) return false
  return true
}

/**
 * Invoke the LLM planner. Caller is responsible for gating via
 * shouldInvokePlanner() to avoid wasted tokens. Returns [] on:
 *   • invalid JSON in the response
 *   • findings array missing or empty
 *   • any thrown error from the client (logged via console.warn, not rethrown
 *     — the planner is a soft fallback, not a hard dependency)
 */
export async function runLlmPlanner(
  ctx: ClarifyContext,
  client: LLMClient,
  opts: LlmPlannerOptions = {},
): Promise<AmbiguityFinding[]> {
  const sampleSize = opts.catalogSampleSize ?? 40
  const maxFindings = opts.maxFindings ?? 4
  const messages: Message[] = [
    { role: MessageRole.System, content: buildSystemPrompt() },
    { role: MessageRole.User, content: buildUserPrompt(ctx, sampleSize) },
  ]
  let raw: string | null
  try {
    const resp = await client.chat(messages, [], {
      signal: opts.signal,
      maxTokens: 600,
      temperature: 0,
    })
    raw = resp.content
  } catch (err) {
    console.warn(`[clarify:llm-planner] chat failed: ${(err as Error).message}`)
    return []
  }
  if (!raw) return []
  const parsed = parsePlannerResponse(raw)
  if (!parsed) return []
  return parsed.slice(0, maxFindings)
}

// ── Prompt construction ──────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    "You are a clarification-detection assistant for a SQL data agent.",
    "",
    "Your job: given a user goal and a sample of the live database catalog,",
    "identify ambiguities the main agent should resolve BEFORE running queries.",
    "Examples of ambiguity:",
    "  • a noun in the goal that could refer to multiple tables/views",
    "  • a business term not present in the catalog at all",
    "  • a vague time range without explicit dates",
    "  • a grain word that matches several columns",
    "  • a ranking word with no metric named",
    "",
    "Respond with a JSON object only, no prose, in this exact shape:",
    "  {",
    "    \"findings\": [",
    "      {",
    "        \"kind\": \"<one of: schema-match | term-undefined | metric-undefined | grain-undefined | time-range | output-format>\",",
    "        \"severity\": \"<block | warn>\",",
    "        \"subject\": \"<the ambiguous word/phrase from the goal>\",",
    "        \"reasoning\": \"<one short sentence>\",",
    "        \"suggestedQuestion\": \"<one direct question to the user>\"",
    "      }",
    "    ]",
    "  }",
    "",
    "Rules:",
    "  • If the goal is unambiguous, return {\"findings\": []}.",
    "  • Never invent table or column names not present in the catalog sample.",
    "  • At most 3 findings; prioritise the most user-blocking ambiguity.",
    "  • Use kind=\"term-undefined\" with severity=\"block\" when a business word",
    "    has no plausible catalog match.",
    "  • Use kind=\"schema-match\" with severity=\"block\" when a word plausibly",
    "    matches two or more catalog identifiers.",
  ].join("\n")
}

function buildUserPrompt(ctx: ClarifyContext, sampleSize: number): string {
  const sample = ctx.catalog
    ? [...ctx.catalog.tables.values()]
        .slice(0, sampleSize)
        .map((t) => `  • ${t.qualifiedName} (${t.type}, columns: ${t.columns.slice(0, 6).map((c) => c.name).join(", ")}${t.columns.length > 6 ? ", …" : ""})`)
        .join("\n")
    : "  (no catalog available)"
  return [
    `User goal: ${ctx.goal}`,
    "",
    `Catalog sample (first ${sampleSize} objects):`,
    sample,
  ].join("\n")
}

// ── Response parsing ─────────────────────────────────────────────

const VALID_KINDS: ReadonlySet<AmbiguityKind> = new Set([
  "schema-match", "term-undefined", "metric-undefined",
  "grain-undefined", "time-range", "output-format",
])
const VALID_SEVERITIES: ReadonlySet<AmbiguitySeverity> = new Set(["block", "warn"])

/**
 * Parse and validate the planner response. Returns null on any
 * structural problem; caller treats null as "no findings". The
 * validation is intentionally strict — we do not coerce or recover,
 * because a malformed planner response is itself a signal that the
 * model could not produce a useful result.
 *
 * Exported for test access.
 */
export function parsePlannerResponse(raw: string): AmbiguityFinding[] | null {
  // strip code fences if the model included them
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim()
  let obj: unknown
  try { obj = JSON.parse(cleaned) } catch { return null }
  if (!obj || typeof obj !== "object") return null
  const findings = (obj as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return null
  const out: AmbiguityFinding[] = []
  for (const f of findings) {
    if (!f || typeof f !== "object") continue
    const rec = f as Record<string, unknown>
    const kind = rec.kind
    const severity = rec.severity
    const subject = rec.subject
    const reasoning = rec.reasoning
    const suggestedQuestion = rec.suggestedQuestion
    if (typeof kind !== "string" || !VALID_KINDS.has(kind as AmbiguityKind)) continue
    if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity as AmbiguitySeverity)) continue
    if (typeof subject !== "string" || subject.length === 0) continue
    if (typeof reasoning !== "string" || reasoning.length === 0) continue
    if (typeof suggestedQuestion !== "string" || suggestedQuestion.length === 0) continue
    out.push({
      id: makeFindingId(kind as AmbiguityKind, subject),
      kind: kind as AmbiguityKind,
      severity: severity as AmbiguitySeverity,
      subject,
      reasoning,
      suggestedQuestion,
      source: "llm-planner",
    })
  }
  return out
}

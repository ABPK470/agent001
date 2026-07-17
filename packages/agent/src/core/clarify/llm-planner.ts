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

import { MessageRole } from "../../domain/enums/message.js"
import type { LLMClient, Message } from "../../domain/types/agent-types.js"
import type { AmbiguityFinding, AmbiguityKind, AmbiguitySeverity, ClarifyContext } from "./types.js"
import { makeFindingId } from "./types.js"

// ── Public surface ───────────────────────────────────────────────

/** Tight co-reference / anaphora detector. Mirrors the one in
 *  schema-match.ts on purpose — the planner uses the same rule to
 *  decide whether the goal is a pronoun-shaped follow-up that should
 *  NOT trigger a fresh clarification at all. */
function looksCoreferential(goal: string): boolean {
  return /\b(it|this|that|these|those|the\s+(data|result|results|report|chart|output|table|rows|answer|response))\b/i.test(
    goal
  )
}

function hasRecentAssistantTurn(messages: readonly Message[]): boolean {
  for (const m of messages) {
    if (m.role === MessageRole.Assistant && typeof m.content === "string" && m.content.trim().length > 0) {
      return true
    }
  }
  return false
}

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
  opts: LlmPlannerOptions = {}
): boolean {
  if (detectorFindings.length > 0) return false
  if (!ctx.catalog) return false
  if (ctx.resolved.length > 0) return false
  if (ctx.round > (opts.maxRound ?? 2)) return false
  if (ctx.goal.trim().length < 8) return false
  // Co-reference guard: a pronoun-shaped follow-up ("plot it", "filter
  // that") with a recent assistant turn in scope is referring to that
  // turn's answer, not to a fresh ambiguity. Skipping the planner here
  // saves an LLM call AND prevents the model from inventing unrelated
  // catalog questions that re-block the conversation — the exact
  // failure mode that motivated this guard.
  if (looksCoreferential(ctx.goal) && hasRecentAssistantTurn(ctx.messages)) return false
  if (ctx.syncOperationIntent) return false
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
  opts: LlmPlannerOptions = {}
): Promise<AmbiguityFinding[]> {
  const sampleSize = opts.catalogSampleSize ?? 40
  const maxFindings = opts.maxFindings ?? 4
  const messages: Message[] = [
    { role: MessageRole.System, content: buildSystemPrompt() },
    { role: MessageRole.User, content: buildUserPrompt(ctx, sampleSize) }
  ]
  let raw: string | null
  try {
    const resp = await client.chat(messages, [], {
      signal: opts.signal,
      maxTokens: 600,
      temperature: 0
    })
    raw = resp.content
  } catch (err) {
    console.warn(`[clarify:llm-planner] chat failed: ${(err as Error).message}`)
    return []
  }
  if (!raw) return []
  const parsed = parsePlannerResponse(raw)
  if (!parsed) return []
  return filterPlannerFindings(ctx, parsed).slice(0, maxFindings)
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
    '    "findings": [',
    "      {",
    '        "kind": "<one of: schema-match | term-undefined | metric-undefined | grain-undefined | time-range | output-format>",',
    '        "severity": "<block | warn>",',
    '        "subject": "<the ambiguous word/phrase from the goal>",',
    '        "reasoning": "<one short sentence>",',
    '        "suggestedQuestion": "<one direct question to the user>"',
    "      }",
    "    ]",
    "  }",
    "",
    "Rules:",
    '  • If the goal is unambiguous, return {"findings": []}.',
    "  • If the user goal uses pronouns / anaphora ('it', 'this', 'that',",
    "    'those results', 'the data', 'the report') AND a recent assistant",
    "    turn appears in the conversation, the referent IS that turn — do",
    "    NOT emit any clarification.",
    "  • Never invent table or column names not present in the catalog sample.",
    "  • At most 3 findings; prioritise the most user-blocking ambiguity.",
    '  • Use kind="term-undefined" with severity="block" when a business word',
    "    has no plausible catalog match.",
    '  • Use kind="schema-match" with severity="block" when a word plausibly',
    "    matches two or more catalog identifiers.",
    "  • Do NOT ask the user to confirm schema-qualified objects that already",
    "    appear in the goal and are present in the catalog sample.",
    "  • Do NOT emit metric-undefined when the goal already names an exact",
    "    numeric column or an aggregate over that exact column.",
    "  • Do NOT emit output-format when the goal already asks for a table,",
    "    chart, list, csv, json, markdown, or other explicit delivery format."
  ].join("\n")
}

function buildUserPrompt(ctx: ClarifyContext, sampleSize: number): string {
  const sample = ctx.catalog
    ? [...ctx.catalog.tables.values()]
        .slice(0, sampleSize)
        .map(
          (t) =>
            `  • ${t.qualifiedName} (${t.type}, columns: ${t.columns
              .slice(0, 6)
              .map((c) => c.name)
              .join(", ")}${t.columns.length > 6 ? ", …" : ""})`
        )
        .join("\n")
    : "  (no catalog available)"
  const conversation = renderConversationPreamble(ctx.messages)
  const parts: string[] = []
  if (conversation) parts.push(conversation, "")
  parts.push(`User goal: ${ctx.goal}`, "", `Catalog sample (first ${sampleSize} objects):`, sample)
  return parts.join("\n")
}

/** Render the last few conversation turns as a compact preamble for the
 *  planner. Cap total length so a chatty session can't blow up the
 *  prompt. Returns the empty string when there are no usable messages
 *  (so callers can omit the section entirely). */
function renderConversationPreamble(messages: readonly Message[]): string {
  if (messages.length === 0) return ""
  const MAX_TOTAL_CHARS = 1500
  const PER_MSG_CHARS = 400
  const tail = messages.slice(-6)
  const lines: string[] = ["Recent conversation (oldest first):"]
  let used = 0
  for (const m of tail) {
    const text = typeof m.content === "string" ? m.content : ""
    if (text.trim().length === 0) continue
    const role =
      m.role === MessageRole.User
        ? "user"
        : m.role === MessageRole.Assistant
          ? "assistant"
          : m.role === MessageRole.System
            ? "system"
            : "tool"
    const trimmed = text.length > PER_MSG_CHARS ? text.slice(0, PER_MSG_CHARS - 1) + "…" : text
    const line = `  [${role}] ${trimmed.replace(/\n+/g, " ⏎ ")}`
    if (used + line.length > MAX_TOTAL_CHARS) break
    lines.push(line)
    used += line.length
  }
  return lines.length > 1 ? lines.join("\n") : ""
}

const QUALIFIED_NAME_RE = /\b([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)\b/g
const EXPLICIT_FORMAT_HINT_RE =
  /\b(table|chart|graph|bar|line|pie|scatter|histogram|csv|json|list|paragraph|narrative|markdown|spreadsheet|excel|dashboard|export)\b/i
const TEMPORAL_OBJECT_RE = /\b(date|calendar|time|month|quarter|week|year|day)\b/i
const NUMERIC_TYPE_HINTS = [
  "decimal",
  "numeric",
  "money",
  "smallmoney",
  "float",
  "real",
  "int",
  "bigint",
  "smallint",
  "tinyint"
] as const

function filterPlannerFindings(
  ctx: ClarifyContext,
  findings: readonly AmbiguityFinding[]
): AmbiguityFinding[] {
  return findings.filter((finding) => !isResolvedByGroundedGoal(ctx, finding))
}

function isResolvedByGroundedGoal(ctx: ClarifyContext, finding: AmbiguityFinding): boolean {
  switch (finding.kind) {
    case "schema-match":
    case "term-undefined":
      return isResolvedObjectConfirmation(ctx, finding)
    case "metric-undefined":
      return isResolvedMetricConfirmation(ctx, finding)
    case "grain-undefined":
      return hasSingleExplicitRowGrain(ctx)
    case "output-format":
      return hasExplicitFormatHint(ctx.goal)
    default:
      return false
  }
}

function isResolvedObjectConfirmation(ctx: ClarifyContext, finding: AmbiguityFinding): boolean {
  if (!ctx.catalog) return false
  const relevantText = `${finding.subject}\n${finding.suggestedQuestion}`
  const qualified = extractQualifiedNames(relevantText)
  const fallbackQualified = qualified.length > 0 ? qualified : extractQualifiedNames(ctx.goal)
  const resolved = fallbackQualified.filter((name) => ctx.catalog?.getTable(name))
  if (resolved.length === 0) return false
  return resolved.length === fallbackQualified.length
}

function isResolvedMetricConfirmation(ctx: ClarifyContext, finding: AmbiguityFinding): boolean {
  if (!ctx.catalog) return false
  const subject = finding.subject.trim().toLowerCase()
  if (!subject) return false
  const tables = ctx.catalog.columnIndex.get(subject)
  if (!tables || tables.size === 0) return false
  for (const tableKey of tables) {
    const table = ctx.catalog.tables.get(tableKey)
    const column = table?.columns.find((col) => col.name.toLowerCase() === subject)
    if (!column) continue
    if (NUMERIC_TYPE_HINTS.some((hint) => column.dataType.toLowerCase().includes(hint))) return true
  }
  return false
}

function hasExplicitFormatHint(goal: string): boolean {
  return EXPLICIT_FORMAT_HINT_RE.test(goal)
}

function hasSingleExplicitRowGrain(ctx: ClarifyContext): boolean {
  if (!ctx.catalog) return false
  const resolvedTables = extractQualifiedNames(ctx.goal)
    .map((name) => ctx.catalog?.getTable(name))
    .filter((table): table is NonNullable<typeof table> => Boolean(table))

  const rowGrainCandidates = resolvedTables.filter((table) => {
    if (table.type === "VIEW") return false
    return !TEMPORAL_OBJECT_RE.test(table.name)
  })

  return rowGrainCandidates.length === 1
}

function extractQualifiedNames(text: string): string[] {
  const out = new Set<string>()
  for (const match of text.matchAll(QUALIFIED_NAME_RE)) out.add(match[0])
  return [...out]
}

// ── Response parsing ─────────────────────────────────────────────

const VALID_KINDS: ReadonlySet<AmbiguityKind> = new Set([
  "schema-match",
  "term-undefined",
  "metric-undefined",
  "grain-undefined",
  "time-range",
  "output-format"
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
  try {
    obj = JSON.parse(cleaned)
  } catch {
    return null
  }
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
      source: "llm-planner"
    })
  }
  return out
}

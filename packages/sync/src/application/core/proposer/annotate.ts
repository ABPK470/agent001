/**
 * F1.3 — Risk annotator.
 *
 * Wraps a generic LLM-completion port behind a strict JSON-schema
 * boundary. Caller passes the proposer finding (and optional context
 * like recent failures + lineage downstreams), the annotator returns a
 * validated `RiskAnnotation` or — after two schema-retries — fails
 * closed by returning a synthetic `critical` annotation.
 *
 * Reproducibility:
 *  - we ALWAYS pass `temperature: 0` to the port
 *  - we deduplicate calls within a single process via the optional
 *    `cache` seam (key = finding.fingerprint)
 */

import {
    RISK_ANNOTATION_JSON_SCHEMA,
    validateRiskAnnotation,
    type RiskAnnotation,
} from "./annotation-schema.js"
import { canonicalJsonStringify } from "./canonical.js"
import { RiskTier, type ProposerFinding } from "./types.js"

// ── LLM port (DI seam — implemented in server by Copilot client) ─

export interface LlmCompletionRequest {
  /** System message + user message, opaque to the annotator. */
  system:      string
  user:        string
  /** Hard cap on response tokens. */
  maxTokens:   number
  temperature: number
  /** Free-form correlation id used by the server-side LLM port to attribute
      token usage to the proposer subsystem in the audit log. */
  purpose:     string
}

export interface LlmCompletionPort {
  complete(req: LlmCompletionRequest): Promise<string>
}

export interface AnnotatorCache {
  get(key: string): RiskAnnotation | null
  put(key: string, value: RiskAnnotation): void
}

export interface AnnotatorContext {
  /** Recent failure modes for this entityType (free-form, ≤ 5 entries). */
  recentFailures?:    readonly string[]
  /** Downstream entities/jobs depending on this entityType. */
  lineageDownstream?: readonly string[]
  /** Active or upcoming freeze windows affecting this env-pair. */
  freezeWindows?:     readonly string[]
}

export interface AnnotateOptions {
  /** Total attempts including the first call (default 3 → 1 initial + 2 retries). */
  maxAttempts?: number
  /** Per-call max tokens (default 700). */
  maxTokens?:   number
}

export interface AnnotateResult {
  annotation:  RiskAnnotation
  attempts:    number
  failedOpen:  boolean
  /** Last raw response (truncated to 4 KB) — useful for forensics. */
  rawTail:     string
}

const DEFAULT_OPTS = { maxAttempts: 3, maxTokens: 700 } as const

const SYSTEM_PROMPT = [
  "You are the Risk Annotator for an enterprise data-reconciliation pipeline.",
  "You receive a JSON finding describing divergence between a source and target",
  "database for one entity, plus optional context (recent failures, lineage,",
  "freeze windows). You MUST reply with a single JSON object matching the",
  "schema in the user message — no markdown, no prose, no code-fence.",
  "If you are uncertain, choose the higher-risk tier and explain why in the",
  "rationale. Never invent table or entity names beyond the input.",
].join(" ")

export async function annotateProposal(
  finding:  ProposerFinding,
  ctx:      AnnotatorContext,
  llm:      LlmCompletionPort,
  cache:    AnnotatorCache | null = null,
  opts:     AnnotateOptions = {},
): Promise<AnnotateResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_OPTS.maxAttempts
  const maxTokens   = opts.maxTokens   ?? DEFAULT_OPTS.maxTokens

  const cached = cache?.get(finding.fingerprint) ?? null
  if (cached) return { annotation: cached, attempts: 0, failedOpen: false, rawTail: "<cached>" }

  const user = buildUserPrompt(finding, ctx)
  let lastRaw = ""
  let lastIssues: string[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reply = await llm.complete({
      system:      SYSTEM_PROMPT,
      user:        attempt === 1 ? user : userWithRetry(user, lastIssues),
      maxTokens,
      temperature: 0,
      purpose:     `proposer.annotate.${finding.fingerprint.slice(0, 12)}`,
    })
    lastRaw = reply

    const parsed = tryParseJson(reply)
    if (parsed === undefined) {
      lastIssues = ["response is not valid JSON"]
      continue
    }
    const v = validateRiskAnnotation(parsed)
    if (v.ok) {
      cache?.put(finding.fingerprint, v.value)
      return { annotation: v.value, attempts: attempt, failedOpen: false, rawTail: truncate(reply) }
    }
    lastIssues = v.issues
  }

  // Failed open → fall back to a synthetic critical annotation. Better to
  // demand human review than to silently let a low-tier slip through.
  const synthetic: RiskAnnotation = {
    riskTier:          RiskTier.Critical,
    riskScore:         95,
    rationale:         [
      "Automated risk annotation failed after the maximum number of attempts.",
      `Last validator issues: ${lastIssues.slice(0, 3).join("; ")}.`,
      "Default tier has been set to critical so a human reviewer must triage this finding.",
    ].join(" "),
    recommendedWindow: "any",
    dependsOn:         [],
    warnings:          [{
      kind:    "unverified-table",
      message: "Risk annotation could not be produced; review counts and lineage manually.",
    }],
  }
  cache?.put(finding.fingerprint, synthetic)
  return { annotation: synthetic, attempts: maxAttempts, failedOpen: true, rawTail: truncate(lastRaw) }
}

// ── prompt builders ─────────────────────────────────────────────

function buildUserPrompt(f: ProposerFinding, ctx: AnnotatorContext): string {
  const payload = {
    finding: {
      envPair:           `${f.envPair.source}→${f.envPair.target}`,
      entityType:        f.entityType,
      entityId:          f.entityId,
      entityLabel:       f.entityLabel,
      kind:              f.kind,
      counts:            f.counts,
      detail:            f.detail,
      entityDefVersion:  f.entityDefVersion,
      observedAt:        f.observedAt,
    },
    context: {
      recentFailures:    ctx.recentFailures    ?? [],
      lineageDownstream: ctx.lineageDownstream ?? [],
      freezeWindows:     ctx.freezeWindows     ?? [],
    },
    schema: RISK_ANNOTATION_JSON_SCHEMA,
  }
  return [
    "Produce a single JSON object matching the embedded JSON schema.",
    "Respond with ONLY the JSON object, no preamble, no markdown.",
    "Input:",
    canonicalJsonStringify(payload),
  ].join("\n")
}

function userWithRetry(originalUser: string, issues: readonly string[]): string {
  return [
    "Your previous reply did not validate. Issues:",
    ...issues.map((i) => `- ${i}`),
    "",
    "Try again. Respond with ONLY the JSON object.",
    "",
    originalUser,
  ].join("\n")
}

function tryParseJson(s: string): unknown {
  const trimmed = stripFence(s.trim())
  try { return JSON.parse(trimmed) as unknown }
  catch { return undefined }
}

function stripFence(s: string): string {
  if (!s.startsWith("```")) return s
  const end = s.lastIndexOf("```")
  if (end <= 3) return s
  const inner = s.slice(s.indexOf("\n") + 1, end).trim()
  return inner
}

function truncate(s: string): string {
  if (s.length <= 4096) return s
  return s.slice(0, 4096) + `…(${s.length - 4096} more bytes)`
}

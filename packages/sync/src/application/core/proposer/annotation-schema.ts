/**
 * Risk annotator — strict JSON schema for the LLM output.
 *
 * The annotator (F1.3) MUST return JSON matching this schema. Two retries
 * are allowed on schema failure; after that the proposal is auto-tiered
 * to `critical` with a rationale explaining the annotation failure.
 *
 * Keep this file free of runtime imports so it can be re-used from
 * tests, docs generation, and (eventually) public JSON-schema export.
 */

import { RISK_SCORE_BANDS, RiskTier } from "./types.js"

export const WarningKind = {
  KnownFailureMode:        "known-failure-mode",
  LineageImpact:           "lineage-impact",
  FreezeWindowViolation:   "freeze-window-violation",
  LargeDeleteBatch:        "large-delete-batch",
  SchemaDrift:             "schema-drift",
  DependencyOrdering:      "dependency-ordering",
  RegulatoryDownstream:    "regulatory-downstream",
  IdentityHandlingChange:  "identity-handling-change",
  HighRiskTimingWindow:    "high-risk-timing-window",
  UnverifiedTable:         "unverified-table",
} as const

export type WarningKind = (typeof WarningKind)[keyof typeof WarningKind]

export interface RiskAnnotationWarning {
  kind:        WarningKind
  message:     string
  /** Optional reference to a specific table or downstream object. */
  reference?:  string
}

export interface RiskAnnotation {
  riskTier:           RiskTier
  /** 0..100; band must agree with `RISK_SCORE_BANDS[riskTier]`. */
  riskScore:          number
  /** 3..6 sentences of plain-English rationale. */
  rationale:          string
  /** ISO datetime range "start/end" OR the literal string "any". */
  recommendedWindow:  string
  /** Entity ids that should sync first. Each must resolve via the registry. */
  dependsOn:          readonly string[]
  warnings:           readonly RiskAnnotationWarning[]
}

/**
 * Validates an unknown payload as a `RiskAnnotation`. Returns the parsed
 * object on success or a list of issues on failure. Pure — no IO.
 */
export function validateRiskAnnotation(
  raw: unknown,
): { ok: true; value: RiskAnnotation } | { ok: false; issues: string[] } {
  const issues: string[] = []
  if (raw === null || typeof raw !== "object") {
    return { ok: false, issues: ["payload is not an object"] }
  }
  const r = raw as Record<string, unknown>

  // riskTier
  const tier = r["riskTier"]
  if (typeof tier !== "string" || !(tier in RISK_SCORE_BANDS)) {
    issues.push(`riskTier must be one of ${Object.keys(RISK_SCORE_BANDS).join(", ")}`)
  }

  // riskScore band consistency
  const score = r["riskScore"]
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
    issues.push("riskScore must be a finite number in [0,100]")
  } else if (typeof tier === "string" && tier in RISK_SCORE_BANDS) {
    const [lo, hi] = RISK_SCORE_BANDS[tier as RiskTier]
    if (score < lo || score > hi) {
      issues.push(`riskScore ${score} is outside the ${tier} band [${lo},${hi}]`)
    }
  }

  // rationale shape
  const rationale = r["rationale"]
  if (typeof rationale !== "string" || rationale.trim().length < 24) {
    issues.push("rationale must be a non-trivial string (≥24 chars)")
  } else {
    const sentenceCount = countSentences(rationale)
    if (sentenceCount < 3 || sentenceCount > 6) {
      issues.push(`rationale must be 3..6 sentences (got ${sentenceCount})`)
    }
  }

  // recommendedWindow
  const win = r["recommendedWindow"]
  if (typeof win !== "string" || (!isIsoWindow(win) && win !== "any")) {
    issues.push("recommendedWindow must be \"any\" or \"<isoStart>/<isoEnd>\"")
  }

  // dependsOn
  const dep = r["dependsOn"]
  if (!Array.isArray(dep) || !dep.every((d) => typeof d === "string" && d.length > 0)) {
    issues.push("dependsOn must be an array of non-empty strings")
  }

  // warnings
  const warns = r["warnings"]
  if (!Array.isArray(warns)) {
    issues.push("warnings must be an array")
  } else {
    for (let i = 0; i < warns.length; i++) {
      const w = warns[i] as Record<string, unknown> | null
      if (w === null || typeof w !== "object") {
        issues.push(`warnings[${i}] is not an object`); continue
      }
      const kind = w["kind"]
      const msg  = w["message"]
      if (typeof kind !== "string" || !Object.values(WarningKind).includes(kind as WarningKind)) {
        issues.push(`warnings[${i}].kind is not a known WarningKind`)
      }
      if (typeof msg !== "string" || msg.length === 0) {
        issues.push(`warnings[${i}].message must be a non-empty string`)
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: raw as unknown as RiskAnnotation }
}

function countSentences(s: string): number {
  // Light heuristic: split on sentence terminators followed by whitespace or EOS.
  return s.split(/[.!?]+(?:\s+|$)/u).filter((p) => p.trim().length > 0).length
}

function isIsoWindow(s: string): boolean {
  const parts = s.split("/")
  if (parts.length !== 2) return false
  const [a, b] = parts
  return !Number.isNaN(Date.parse(a!)) && !Number.isNaN(Date.parse(b!))
}

// ── JSON-schema (informational; mirrors the validator above) ────────

export const RISK_ANNOTATION_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title:   "RiskAnnotation",
  type:    "object",
  required: ["riskTier", "riskScore", "rationale", "recommendedWindow", "dependsOn", "warnings"],
  additionalProperties: false,
  properties: {
    riskTier:          { enum: Object.keys(RISK_SCORE_BANDS) },
    riskScore:         { type: "number", minimum: 0, maximum: 100 },
    rationale:         { type: "string", minLength: 24 },
    recommendedWindow: { type: "string", description: "\"any\" or \"<isoStart>/<isoEnd>\"" },
    dependsOn:         { type: "array", items: { type: "string", minLength: 1 } },
    warnings: {
      type:  "array",
      items: {
        type: "object",
        required: ["kind", "message"],
        additionalProperties: false,
        properties: {
          kind:      { enum: Object.values(WarningKind) },
          message:   { type: "string", minLength: 1 },
          reference: { type: "string" },
        },
      },
    },
  },
} as const

/**
 * Token estimation — single source of truth.
 *
 * Replaces ad-hoc `Math.ceil(chars / 4)` sites scattered across the
 * context layer with a per-model-aware abstraction. The default falls
 * back to chars/4 to preserve historical behavior; per-model factors
 * tune the heuristic for known families (Anthropic Claude tokenises
 * slightly tighter than GPT for most prose, Gemini matches GPT).
 *
 * If `MIA_USE_TIKTOKEN=1` is set AND the optional `tiktoken` dependency
 * resolves at runtime, GPT-family models route through tiktoken for an
 * exact count. All other paths stay on the heuristic — no hard dep.
 *
 * @module
 */

import { createRequire } from "node:module"
import type { Message } from "../domain/models/agent-types.js"

const requireCJS = createRequire(import.meta.url)

/** Default chars-per-token when no model hint is provided. */
export const DEFAULT_CHAR_PER_TOKEN = 4

/**
 * Per-model-family chars-per-token factors. Higher = fewer tokens per char.
 *
 * Derived from empirical samples on prose + code mixes. Keep this table
 * conservative — under-estimating tokens (i.e. higher chars-per-token)
 * leads to budget overruns; we prefer the safer side.
 */
const MODEL_FAMILY_FACTOR: ReadonlyArray<readonly [RegExp, number]> = [
  [/^gpt-/i, 4],
  [/^o[1-9]/i, 4],
  [/^claude/i, 3.5],
  [/^anthropic/i, 3.5],
  [/^gemini/i, 4],
  [/^llama/i, 3.8],
  [/^mistral/i, 3.8]
]

/**
 * Resolve chars-per-token for a model hint. Returns DEFAULT when no
 * hint or no family matches.
 */
export function charPerToken(model?: string): number {
  if (!model) return DEFAULT_CHAR_PER_TOKEN
  for (const [pattern, factor] of MODEL_FAMILY_FACTOR) {
    if (pattern.test(model)) return factor
  }
  return DEFAULT_CHAR_PER_TOKEN
}

// ── Optional tiktoken (dynamic, lazy, never required) ────────────

interface TiktokenLike {
  encode(text: string): { length: number } | number[]
}
const tiktokenCache = new Map<string, TiktokenLike | null>()
const tiktokenState: {
  module:
    | { encoding_for_model?: (m: string) => TiktokenLike; get_encoding?: (n: string) => TiktokenLike }
    | null
    | undefined
} = { module: undefined }

function tiktokenFor(model: string): TiktokenLike | null {
  if (process.env.MIA_USE_TIKTOKEN !== "1") return null
  if (!/^gpt-|^o[1-9]/i.test(model)) return null
  if (tiktokenCache.has(model)) return tiktokenCache.get(model) ?? null
  if (tiktokenState.module === undefined) {
    try {
      // Use a Node createRequire (ESM-safe, sync) so esbuild doesn't warn
      // about direct eval. tiktoken is marked external in scripts/build.mjs
      // (packages: "external"), so the bundler leaves this require alone.
      tiktokenState.module = requireCJS("tiktoken") as typeof tiktokenState.module
    } catch {
      tiktokenState.module = null
    }
  }
  if (!tiktokenState.module) {
    tiktokenCache.set(model, null)
    return null
  }
  let enc: TiktokenLike | null = null
  try {
    enc =
      tiktokenState.module.encoding_for_model?.(model) ??
      tiktokenState.module.get_encoding?.("cl100k_base") ??
      null
  } catch {
    enc = null
  }
  tiktokenCache.set(model, enc)
  return enc
}

// ── Public API ────────────────────────────────────────────────────

/** Estimate tokens for a single text string. */
export function estimateTokensFromText(text: string, model?: string): number {
  if (!text) return 0
  if (model) {
    const enc = tiktokenFor(model)
    if (enc) {
      const r = enc.encode(text)
      return Array.isArray(r) ? r.length : r.length
    }
  }
  return Math.ceil(text.length / charPerToken(model))
}

/** Estimate tokens for a raw character count. */
export function estimateTokensFromChars(chars: number, model?: string): number {
  if (chars <= 0) return 0
  return Math.ceil(chars / charPerToken(model))
}

/** Estimate tokens for an array of messages (content + tool-call payloads). */
export function estimateTokensFromMessages(messages: readonly Message[], model?: string): number {
  let chars = 0
  for (const m of messages) {
    chars += (m.content ?? "").length
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        chars += tc.name.length + JSON.stringify(tc.arguments).length
      }
    }
  }
  return estimateTokensFromChars(chars, model)
}

/**
 * Per-section token breakdown — used by telemetry hooks to surface
 * which slice of the prompt is dominating budget consumption.
 */
export function tokensBySection(messages: readonly Message[], model?: string): Record<string, number> {
  const cpt = charPerToken(model)
  const out: Record<string, number> = {}
  for (const m of messages) {
    const sec = m.section ?? m.role ?? "other"
    const len =
      (m.content ?? "").length +
      (m.toolCalls?.reduce((s, tc) => s + tc.name.length + JSON.stringify(tc.arguments).length, 0) ?? 0)
    out[sec] = (out[sec] ?? 0) + Math.ceil(len / cpt)
  }
  return out
}

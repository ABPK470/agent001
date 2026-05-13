/**
 * Anti-paste guard: detect when the model is about to dump a previously
 * truncated `query_mssql` result into a file-mutation tool. Such writes
 * silently produce broken/partial files; we redirect the model to
 * `export_query_to_file` instead.
 *
 * @module
 */

import type { AgentLoopState } from "../state.js"
import {
    ANTIPASTE_MIN_CONTENT_LEN,
    ANTIPASTE_NEEDLE_LEN,
    MAX_TRUNCATED_FINGERPRINTS,
} from "./types.js"

/**
 * Extract a distinctive substring ("needle") from a truncated query_mssql
 * result so we can later detect when the model copy-pastes that result into
 * a file mutation. We skip the first ~200 chars (header / column names) and
 * grab a slice from the data body where two outputs are unlikely to coincide.
 */
export function extractTruncationFingerprint(result: string): string | null {
  if (typeof result !== "string" || result.length < ANTIPASTE_MIN_CONTENT_LEN) return null
  const start = Math.min(250, Math.max(0, result.length - ANTIPASTE_NEEDLE_LEN - 50))
  const needle = result.slice(start, start + ANTIPASTE_NEEDLE_LEN).trim()
  return needle.length >= 60 ? needle : null
}

/** Pull the writable payload string out of a file-mutation tool call. */
export function extractWritePayload(name: string, args: Record<string, unknown>): string {
  if (name === "replace_in_file") return typeof args.new_string === "string" ? args.new_string : ""
  // write_file and append_file both use `content`
  return typeof args.content === "string" ? args.content : ""
}

/**
 * Record a truncation fingerprint + originating SQL into the loop state
 * so future rounds can recognize a copy-paste of this result.
 */
export function recordTruncatedQuery(
  state: AgentLoopState,
  enrichedResult: string,
  args: Record<string, unknown>,
): void {
  const wasTruncated = /TRUNCATION WARNING|ROW LIMIT WARNING|\(output truncated\)/.test(enrichedResult)
  if (!wasTruncated) return
  const needle = extractTruncationFingerprint(enrichedResult)
  const query = typeof args.query === "string" ? args.query : ""
  if (!needle || !query) return
  state.recentTruncatedQueries.push({ fingerprint: needle, query })
  if (state.recentTruncatedQueries.length > MAX_TRUNCATED_FINGERPRINTS) {
    state.recentTruncatedQueries.shift()
  }
}

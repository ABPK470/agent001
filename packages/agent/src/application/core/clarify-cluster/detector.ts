// Clarification runner — orchestrates the registered detectors over a
// single ClarifyContext and returns deduplicated findings.
//
// Detectors are pure functions; this module owns the cross-detector
// concerns: (a) suppress findings whose id is already in ctx.resolved,
// (b) dedupe when two detectors emit the same id (last-write-wins by
// detector registration order — but in practice each id is owned by one
// kind), (c) stable ordering for snapshot tests.

import type {
    AmbiguityFinding,
    ClarifyContext,
    Detector,
} from "./types.js"

/**
 * Run every detector in order, suppress resolved-finding ids, dedupe by
 * finding id, and return the surviving findings in registration order
 * (within a kind, in detector-returned order — detectors are expected to
 * order their own output deterministically).
 *
 * Throws if any detector throws — detectors are pure code and must not
 * fail at runtime; a thrown error is a bug, not a graceful-degradation
 * scenario. The caller (system-messages assembly) will catch and log so
 * a buggy detector does not break the entire round, but the runner does
 * not silently swallow.
 */
export function runDetectors(
  ctx: ClarifyContext,
  detectors: readonly Detector[],
): AmbiguityFinding[] {
  const resolved = new Set(ctx.resolved.map((r) => r.findingId))
  const seen = new Set<string>()
  const out: AmbiguityFinding[] = []
  for (const d of detectors) {
    const findings = d.detect(ctx)
    for (const f of findings) {
      if (resolved.has(f.id)) continue
      if (seen.has(f.id)) continue
      seen.add(f.id)
      out.push(f)
    }
  }
  return out
}

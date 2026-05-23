// anaphora-ungrounded detector — "you're pointing at prior data, but
// no structured payload survived the turn boundary".
//
// Fires WARN-severity when:
//   (1) the current goal is co-referential ("plot it", "filter that",
//       "now those clients only", "the chart from before"); AND
//   (2) at least one prior assistant turn exists in this session
//       (otherwise there is nothing to refer to and `empty-result` /
//       `term-undefined` will catch it); AND
//   (3) `ctx.priorResultsCount === 0` — the orchestrator found NO
//       entries in the `tool_results` table for this session, so the
//       `<prior_results>` system_anchor is empty.
//
// In that state the only thing the model has from the prior turn is the
// narrative paraphrase in `<prior_turns>`. Quoting numbers, rows, names
// or percentages out of that paraphrase is the no-amnesia trap that
// produced the 22-May-2026 "I made up the chart numbers" incident: the
// model treated its own prose as evidence and confabulated quantified
// output to keep the dialogue flowing.
//
// The finding tells the agent to either re-run the underlying query
// (cheap, deterministic) or call `recall_prior_result(...)` on an
// explicit run/tool-call pair if it knows one. The suggestedQuestion
// is the ask_user fallback when neither path is feasible (e.g. the
// user changed connection between turns).
//
// Sibling of `canonical-ambiguity` — same coreference heuristic, same
// "warn-severity finding inside the clarify pipeline" pattern. They
// fire on disjoint conditions:
//   • canonical-ambiguity = "I know which kind of object you mean, but
//     two catalog candidates are too close to call"
//   • anaphora-ungrounded = "you're pointing at data from before, but
//     the data itself isn't recallable"
// One detector per kind (per the invariant in types.ts), hence a
// separate module rather than a second firing-mode in canonical-ambiguity.
//
// Pure function of ClarifyContext. No I/O, no LLM.

import { MessageRole } from "../../domain/enums/message.js"
import type { ClarifyContext, Detector } from "../types.js"
import { makeFindingId } from "../types.js"

/**
 * 1.0.0: initial release. Fires when (coreferential goal) ∧ (prior
 * assistant turn exists) ∧ (priorResultsCount === 0). Severity = warn:
 * the agent is still allowed to proceed (e.g. re-run a query) without
 * blocking on ask_user, but the finding is rendered in <must_clarify>
 * so the doctrine is in front of the model when it composes the answer.
 */
const VERSION = "1.0.0"

/**
 * Same co-reference heuristic as canonical-ambiguity and schema-match.
 * Kept duplicated (rather than extracted into a shared helper) so each
 * detector remains a fully self-contained pure function — easier to
 * reason about, unit-test, and reuse without an import-graph dance.
 */
function looksCoreferential(goal: string): boolean {
  return /\b(it|this|that|these|those|the\s+(data|result|results|report|chart|output|table|rows|answer|response))\b/i.test(goal)
}

/** Walks newest-last messages; returns true on first non-empty assistant content. */
function hasRecentAssistantTurn(messages: readonly ClarifyContext["messages"][number][]): boolean {
  for (const m of messages) {
    if (m.role === MessageRole.Assistant && typeof m.content === "string" && m.content.trim().length > 0) {
      return true
    }
  }
  return false
}

export const anaphoraUngroundedDetector: Detector = {
  id: "anaphora-ungrounded",
  version: VERSION,

  detect(ctx) {
    // No prior-results signal injected → orchestrator isn't in scope
    // (CLI / tests). The whole no-amnesia mechanism is server-side, so
    // there is nothing to ground against; stay silent.
    if (ctx.priorResultsCount === undefined) return []

    // Goal must point backward; otherwise this is a fresh ask and
    // `<prior_results>` emptiness is irrelevant.
    if (!looksCoreferential(ctx.goal)) return []

    // No prior assistant turn means "it" / "that" can't be a back-reference
    // to assistant output. Other detectors (term-undefined, metric-undefined)
    // handle vague first-turn nouns.
    if (!hasRecentAssistantTurn(ctx.messages)) return []

    // The grounded path: there IS recallable tool evidence for this
    // session. The agent can quote from <prior_results> or call
    // recall_prior_result(...) — no clarification needed.
    if (ctx.priorResultsCount > 0) return []

    // Otherwise: goal points back, prior turn exists, no payload survived.
    return [{
      id: makeFindingId("anaphora-ungrounded", "prior-turn"),
      kind: "anaphora-ungrounded" as const,
      severity: "warn" as const,
      subject: "prior-turn data",
      reasoning:
        "The goal refers back to a previous turn's data, but no structured " +
        "tool payload from that turn is recallable this round — only the " +
        "assistant's own narrative paraphrase in <prior_turns> survives. " +
        "Quoting specific numbers, rows or names from that paraphrase is " +
        "the no-amnesia trap; re-run the underlying query (or call " +
        "recall_prior_result with an explicit run/tool-call id) instead of " +
        "fabricating values to keep the answer flowing.",
      suggestedQuestion:
        "I don't have the rows from the previous step stored — should I " +
        "re-run the query that produced them, or would you like to point me " +
        "at a different source?",
      source: "detector" as const,
    }]
  },
}

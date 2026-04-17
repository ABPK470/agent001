/**
 * Planner decision patterns — regex constants for routing layers.
 *
 * Extracted from decision.ts for maintainability.
 * Each pattern has a clear role documented inline.
 *
 * @module
 */

// ============================================================================
// Layer 1: Semantic hard-gate patterns
// ============================================================================

/** Multi-step work: "build X then Y", "first...then...", numbered lists */
export const MULTI_STEP_RE =
  /\b(?:first|then|next|after that|step \d|phase \d|\d+\.\s|\bfinally\b)/i

/** Tool diversity: mentions different tool categories */
export const TOOL_DIVERSITY_RE =
  /\b(?:create|write|build|implement|test|verify|check|run|deploy|configure|install)\b/i

/**
 * Delegation cue: multiple independent components or parallel work.
 * Uses [^.!?\n] to prevent cross-sentence false positives (e.g. "all project
 * files will be stored. Build a chess game" no longer fires).
 */
export const DELEGATION_RE =
  /\b(sub[\s-]?agent|child agent|execute_with_agent|delegate|delegation|parallel(?:ize|ism)?|fanout)\b/i

/** Implementation scope: large-scale creation request */
export const IMPLEMENTATION_SCOPE_RE =
  /\b(?:build|create|implement|develop|make|write)\b[\s\S]{0,100}\b(?:app(?:lication)?|game|website|site|project|system|platform|service|api|dashboard|tool|library|framework|clone|full|complete|entire|whole)\b/i

/** Verification cue: request mentions testing/verification */
export const VERIFICATION_RE =
  /\b(?:test|verify|ensure|check|validate|confirm|working|functional|playable|interactive)\b/i

/** Simple dialogue: just a question or greeting */
export const SIMPLE_DIALOGUE_RE =
  /^(?:hi|hello|hey|thanks?|thank you|what is|how do|can you explain|tell me about)\b/i

/** Review/analysis question: not implementation, just looking at things */
export const REVIEW_QUESTION_RE =
  /\b(?:read\s+through|review|analyze|check|look\s+at|go\s+through|evaluate|assess)\b[\s\S]{0,60}\?/i

/** Exact response: user wants a literal output, not an orchestrated build */
export const EXACT_RESPONSE_RE =
  /\b(?:respond\s+with|output\s+exactly|just\s+(?:say|write|output|reply|return)|^(?:say|write|echo)\b)/i

/** Memory/recall: storing or retrieving info (no planning needed) */
export const DIALOGUE_MEMORY_RE =
  /\b(?:remember|memorize|save\s+(?:this|that)|store\s+(?:this|that)|note\s+that|keep\s+in\s+mind)\b/i
export const DIALOGUE_RECALL_RE =
  /\b(?:what\s+did\s+(?:I|you|we)|recall|do\s+you\s+remember|earlier\s+(?:I|you|we))\b/i
/** Second guard for recall gate: must reference a prior turn, not just contain the word */
export const DIALOGUE_RECALL_REFERENCE_RE =
  /\b(?:from\s+(?:earlier|before|above|prior|previous|last\s+turn|prior\s+turn)|(?:you|i)\s+(?:stored|memorized|remembered|told)|those\s+facts|these\s+facts|the\s+facts|last\s+turn|prior\s+turn|previous\s+turn|continuity\s+test)\b/i

/**
 * Explicit environment action cue: the message asks the agent to DO something
 * in the environment (use a tool, build, write, run, etc.).
 * Used to guard dialogue-only gates — if this fires, the message is NOT
 * a pure dialogue turn even if memory/recall/exact-response cues also fired.
 */
export const EXPLICIT_ENV_ACTION_RE =
  /\b(?:use|call|invoke|run|start|stop|create|write|edit|save|open|navigate|click|search|browse|inspect|read|check|verify|delegate|spawn|launch|post|publish|deploy|install|build|implement|refactor|migrate|continue)\b[\s\S]{0,96}\b(?:tool|tools|file|files|server|process|service|api|endpoint|project|tests?|[a-z][\w-]*\.[a-z][\w.-]*)\b/i

/** Edit artifact: simple read-edit-write cycle that one agent handles better */
export const EDIT_ARTIFACT_RE =
  /\b(?:edit|update|change|modify|fix|patch|rename|refactor|replace)\b[\s\S]{0,80}\b(?:in|of|the\s+file|this\s+file|\.(?:ts|js|tsx|jsx|css|html|json|md|py|rs|go))\b/i

/** Plan/document creation: user asks agent to write a plan, doc, or spec */
export const PLAN_CREATION_RE =
  /\b(?:write|create|draft|make)\s+(?:a\s+)?(?:plan|spec|proposal|document|outline|summary|report|readme|changelog)\b/i

/**
 * Database investigation task: explore schema structure, find views/joins/tables,
 * analyze performance, inspect definitions — pure tool-call work that produces
 * answers, not code files.
 *
 * Without this gate, the planner's score threshold fires on multi-step goals
 * like "identify top N views and then find unnecessary joins" (the word "then"
 * alone scores 3 via MULTI_STEP_RE, which equals the shouldPlan threshold).
 * The planner then generates a BLUEPRINT.md with TypeScript-style function
 * signatures inside .json data files — a category error: it treats a database
 * investigation as a software build.
 *
 * Must be checked BEFORE hasImplementationScopeCue so that a goal like
 * "build a tool that identifies views" does not get blocked (IMPLEMENTATION_SCOPE_RE
 * fires first and prevents this gate from activating via the hasImplementationScopeCue
 * guard in assess.ts).
 */
export const DB_INVESTIGATION_RE =
  /\b(?:identify|find(?:\s+out)?|discover|analyse|analyze|inspect|examine|scan|look\s+for|explore)\b[\s\S]{0,120}\b(?:view|views|join|joins|table|tables|schema|schemas|index|indexes|indices|column|columns|slow|duplicate\s+join|unnecessary\s+join|redundant|inefficien)\b|\b(?:view|views|join|joins|schema|schemas)\b[\s\S]{0,80}\b(?:slow|redundant|unnecessary|duplicate|inefficien|identify|find|discover|analyze|analyse|inspect)\b/i

/**
 * Data-fetch pipeline: "query database → produce output".
 * Must go to the direct tool-loop so the agent can call query_mssql and
 * write_file with real data rather than generating a full server architecture.
 */
export const DATA_FETCH_PIPELINE_RE =
  /\b(?:query|fetch|get|pull|retrieve|select|show|display|list|report\s+on|generate\s+(?:a\s+)?report)\b[\s\S]{0,80}\b(?:from\s+)?(?:database|db|mssql|sql\s+server|sql|table|data)\b|\b(?:mssql|sql\s+server|database|db)\b[\s\S]{0,80}\b(?:report|table|chart|display|html|dashboard|page|export|output|result)\b/i

/** High-throughput direct coding: single-artifact implementation in one file */
export const SINGLE_ARTIFACT_BURST_RE =
  /\b(?:single|one|only)\s+(?:file|module|component|page|script)\b|\b(?:in|into)\s+[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|html|css|sql)\b/i

/** User explicitly asks for a full cohesive implementation pass */
export const COHESIVE_IMPLEMENTATION_RE =
  /\b(?:full|complete|entire|end[- ]to[- ]end|from scratch|all logic|whole implementation)\b/i

/** Strong greenfield coherence cues */
export const COHERENCE_FIRST_RE =
  /\b(?:playable|interactive|drag and drop|drag-and-drop|fully working|working end[- ]to[- ]end)\b/i

/** Concrete file targets */
export const TARGET_FILE_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|html|css|sql)\b/gi

/** Conflicting multi-target cues */
export const MULTI_TARGET_CUE_RE =
  /\b(?:and|plus|along with|together with)\b[\s\S]{0,40}\b(?:files?|modules?|components?|pages?|scripts?|api|services?|backend|frontend|database|schema|tests?)\b/i

/**
 * Prior no-progress signal: the direct tool loop already failed and left a
 * recovery hint in the history. Scoring this up pushes toward planner routing
 * (the simple path failed — escalate). Mirrors agenc-core's hasPriorNoProgressSignal.
 */
export const RECOVERY_HINT_RE = /\[recovery\]|no[_\s]progress|stuck|repeated[_\s]failure|escalat/i

// ============================================================================
// Layer 2: Advisory heuristic patterns (signals, not decisions)
// ============================================================================

/** Bounded greenfield builds benefit from coherence before decomposition */
export const BOUNDED_COHERENT_SCOPE_RE =
  /\b(?:build|create|implement|develop|make|write)\b[\s\S]{0,80}\b(?:app(?:lication)?|game|website|site|tool|dashboard|widget|prototype|project|starter|platform|system)\b/i

/** Larger greenfield system cues justify architecture freeze before decomposition */
export const LARGE_GREENFIELD_BOOTSTRAP_RE =
  /\b(?:starter|platform|system|suite|workspace|tenant|billing|worker|backend|frontend|api|service|admin)\b/i

/**
 * Existing-code coupling tends to require planner coordination.
 * This is a HARD override: never route coupled work to bounded coherent gen.
 */
export const EXISTING_CODE_COUPLING_RE =
  /\b(?:existing|current|already|integrat(?:e|ion)|hook\s+into|wire\s+into|refactor|migrat(?:e|ion)|extend|modify|update|patch|rename|repair)\b/i

/** Explicit coordination-heavy requests */
export const COORDINATION_HEAVY_RE =
  /\b(?:multiple|several|coordinated|shared|cross[- ]file|cross[- ]module|across|between|independent)\b[\s\S]{0,40}\b(?:files?|modules?|components?|pages?|sections?|widgets?|panels?|interactions?)\b/i

/**
 * External service cues: signals that the task involves infrastructure beyond
 * simple filesystem writes. Used by the sanity override to scope it to truly
 * bounded builds.
 */
export const EXTERNAL_SERVICE_RE =
  /\b(?:mssql|sql\s+server|postgres|mysql|mongo|redis|kafka|rabbitmq|deploy|kubernetes|docker\s+swarm|aws|azure|gcp|cloud\s+run|lambda|microservice|oauth|saml|stripe|twilio|sendgrid|broker|message\s+queue)\b/i

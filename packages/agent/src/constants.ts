/**
 * Constants for the agent execution engine.
 *
 * Ported from agenc-core chat-executor-constants.ts, adapted for agent001 tool names.
 *
 * @module
 */

// ============================================================================
// Size and limit constants
// ============================================================================

/** Max chars for tool-call argument payloads stored for replay. */
export const MAX_TOOL_CALL_ARGUMENT_CHARS = 100_000
/** Max chars retained from raw tool results. */
export const MAX_TOOL_RESULT_CHARS = 100_000
/** Hard prompt-size guard (approx chars) to avoid context overflow. */
export const MAX_PROMPT_CHARS_BUDGET = 500_000
/** Cap history depth sent to providers per request. */
export const MAX_HISTORY_MESSAGES = 100
/** Max chars retained per history message. */
export const MAX_HISTORY_MESSAGE_CHARS = 100_000
/** Max chars from a single injected system context block. */
export const MAX_CONTEXT_INJECTION_CHARS = 100_000
/** Hard cap for final assistant response size. */
export const MAX_FINAL_RESPONSE_CHARS = 24_000
/** Max chars retained from single user text message. */
export const MAX_USER_MESSAGE_CHARS = 8_000
/** Max chars for JSON result previews in tool summaries. */
export const MAX_RESULT_PREVIEW_CHARS = 10_000
/** Max chars for error message previews. */
export const MAX_ERROR_PREVIEW_CHARS = 10_000

// ============================================================================
// Stuck detection
// ============================================================================

/**
 * Max consecutive identical failing tool calls before the loop is broken.
 * After (N-1) attempts, inject a hint. After N, break.
 */
export const MAX_CONSECUTIVE_IDENTICAL_FAILURES = 3
/** Break tool loop after N rounds where every tool call failed. */
export const MAX_CONSECUTIVE_ALL_FAILED_ROUNDS = 3
/** Break no-progress loops after repeated semantically equivalent rounds. */
export const MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS = 2
/** Upper bound on additive runtime hint system messages per execution. */
export const MAX_RUNTIME_SYSTEM_HINTS = 4

// ============================================================================
// Repetitive output detection
// ============================================================================

/** Minimum line count before repetitive-output suppression is evaluated. */
export const REPETITIVE_LINE_MIN_COUNT = 40
/** Dominant-line repetition threshold for runaway detection. */
export const REPETITIVE_LINE_MIN_REPEATS = 20
/** Unique-line ratio threshold for runaway detection. */
export const REPETITIVE_LINE_MAX_UNIQUE_RATIO = 0.35

// ============================================================================
// Verifier
// ============================================================================

/** Default minimum verifier confidence for accepting subagent outputs. */
export const DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE = 0.65
/** Default max rounds for verifier/critique loops (initial round included). */
export const DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS = 2
/** Max chars retained from one subagent output in verifier prompts. */
export const MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS = 3_000
/** Max chars retained from one verifier artifact payload. */
export const MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS = 2_000

// ============================================================================
// Planner
// ============================================================================

/** Default max planner output budget in tokens. 0 = unlimited. */
export const DEFAULT_PLANNER_MAX_TOKENS = 0
/** Max refinement attempts when a delegated step is rejected. */
export const DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS = 2
/** Default retries for planner step-contract cleanup. */
export const DEFAULT_PLANNER_MAX_STEP_CONTRACT_RETRIES = 1
/** Additional repair replans when deterministic verification still fails. */
export const DEFAULT_PLANNER_MAX_RUNTIME_REPAIR_RETRIES = 1
/** Max deterministic steps accepted from a planner pass. 0 = unlimited. */
export const MAX_PLANNER_STEPS = 0
/** Parent history slice candidates retained for per-subagent curation. */
export const MAX_PLANNER_CONTEXT_HISTORY_CANDIDATES = 12
/** Max chars for planner history candidate entries. */
export const MAX_PLANNER_CONTEXT_HISTORY_CHARS = 600
/** Max chars for planner memory candidate entries. */
export const MAX_PLANNER_CONTEXT_MEMORY_CHARS = 1_200
/** Max chars for planner tool-output candidate entries. */
export const MAX_PLANNER_CONTEXT_TOOL_OUTPUT_CHARS = 1_200

// ============================================================================
// Budget & timeouts
// ============================================================================

/** Default per-request tool-call budget. 0 = unlimited. */
export const DEFAULT_TOOL_BUDGET_PER_REQUEST = 0
/** Default per-request model recall budget. 0 = unlimited. */
export const DEFAULT_MODEL_RECALLS_PER_REQUEST = 0
/** Default per-request failed-tool-call budget. 0 = unlimited. */
export const DEFAULT_FAILURE_BUDGET_PER_REQUEST = 0
/** Default timeout for a single tool execution in ms. 0 = unlimited. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 0
/** Default end-to-end timeout for one execute() invocation in ms. 0 = unlimited. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 0
/** Max adaptive tool rounds ceiling. 0 = unlimited. */
export const MAX_ADAPTIVE_TOOL_ROUNDS = 0

// ============================================================================
// Circuit breaker
// ============================================================================

/** Default repeated-failure threshold before opening session breaker. */
export const DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD = 5
/** Default rolling window for repeated-failure breaker accounting (ms). */
export const DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS = 300_000
/** Default cooldown once repeated-failure breaker opens (ms). */
export const DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS = 120_000

// ============================================================================
// Tool classification sets (agent001 tool names)
// ============================================================================

/** High-risk side-effect tools — must not be auto-retried. */
export const HIGH_RISK_TOOLS = new Set([
  "run_command",
  "write_file",
  "delete",
  "delegate",
  "delegate_parallel",
])

/**
 * Safe tools that can be retried on transient failures (timeouts, network).
 * Read-only tools that don't mutate workspace state.
 */
export const SAFE_RETRY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "browse_web",
  "fetch_url",
  "browser_check",
  "think",
])

/** Tools that indicate verification activity. */
export const VERIFICATION_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "browser_check",
])

/** Tools that indicate workspace mutation. */
export const MUTATION_TOOLS = new Set([
  "write_file",
  "delete",
  "run_command",
])

/** Shell builtin commands (for bash/command parsing). */
export const SHELL_BUILTIN_COMMANDS = new Set([
  "set", "cd", "export", "source", "alias", "unalias", "unset",
  "shopt", "ulimit", "umask", "readonly", "declare", "typeset", "builtin",
])

/** Recovery hint prefix used in system messages. */
export const RECOVERY_HINT_PREFIX = "Tool recovery hint:"

/** Default evaluation rubric for response critics. */
export const DEFAULT_EVAL_RUBRIC =
  "Rate this AI response 0.0-1.0. Consider accuracy, completeness, clarity, " +
  "and appropriate use of tool results.\n" +
  'Return ONLY JSON: {"score": 0.0-1.0, "feedback": "brief explanation"}'

/** Max chars of history text sent to the summarization call. */
export const MAX_COMPACT_INPUT = 20_000

/** Priority keys when summarizing JSON tool results (checked first). */
export const TOOL_RESULT_PRIORITY_KEYS = [
  "error", "stderr", "stdout", "exitcode", "status", "message",
  "result", "output", "url", "title", "text", "data",
] as const

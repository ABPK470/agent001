/**
 * Regex / set constants used by the delegation-validation pattern helpers.
 *
 * @module
 */

/** Empty values that indicate no real output. */
export const EMPTY_VALUES = new Set(["null", "undefined", "{}", "[]", ""])

/** Completion claim language in output text. */
export const COMPLETION_CLAIM_RE =
  /\b(?:done|complete(?:d)?|finished|implemented|created|written|ready|passes?|passing|succeeds?|successful(?:ly)?|meets?(?: the)? acceptance criteria|all (?:tasks?|criteria|requirements?) (?:met|satisfied|done))\b/i

/** Unresolved work markers — the child claims "done" but these indicate otherwise. */
export const UNRESOLVED_WORK_RE =
  /\b(?:TODO|FIXME|HACK|XXX|NOT YET|UNFINISHED|NEEDS? (?:TO BE )?IMPLEMENT|WILL GO HERE|WILL BE ADDED|WAITING FOR|DEPENDS ON|UNABLE TO|FAILED TO|ERROR(?:S)? (?:OCCURRED|ENCOUNTERED)|REMAINING WORK|FOLLOW[- ]?UP|PARTIAL(?:LY)? IMPLEMENTED)\b/i

/** Context-sensitive markers — only flag these when they appear in "unresolved work" context, not in normal English descriptions. */
export const CONTEXT_SENSITIVE_MARKERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\b(?:do|implement|fix|add|handle|address|revisit|come back(?:to)?)\s+later\b/i, label: "later" },
  { re: /\b(?:incomplete\s+(?:implementation|code|logic|work|feature)|(?:implementation|code|logic|work|feature)\s+(?:is|are|remains?)\s+incomplete)\b/i, label: "incomplete" },
  { re: /\bwill be\s+(?:implemented|added|done|completed|fixed|handled|addressed)\b/i, label: "will be" },
  { re: /\b(?:blocked on|blocked by)\s+(?:a |the |an )?(?:missing|lack|absence|dependency|requirement|issue|bug|error)/i, label: "blocked on" },
  { re: /\b(?:can'?t|cannot)\s+(?:implement|complete|finish|fix|resolve|access|proceed)/i, label: "can't" },
  { re: /\b(?:placeholder|stub)\s+(?:logic|code|function|implementation)\b/i, label: "placeholder/stub" },
]

/** File mutation tool names — tools that create/modify/delete files. */
export const FILE_MUTATION_TOOLS = new Set([
  "write_file", "append_file", "replace_in_file",
])

/** File reading tool names. */
export const FILE_READ_TOOLS = new Set([
  "read_file", "list_directory", "search_files",
])

/** Commands that provide executable verification evidence. */
export const EXECUTABLE_VERIFICATION_CMD_RE =
  /\b(?:npm\s+test|npm\s+run\s+(?:test|lint|build|check)|pnpm\s+(?:test|lint|build|check)|yarn\s+(?:test|lint|build|check)|vitest|jest|pytest|go\s+test|cargo\s+test|cargo\s+check|mvn\s+test|gradle\s+test|ruff\s+check|eslint|tsc\b|phpunit|dotnet\s+test)\b/i

/** Browser runtime/load failures that invalidate browser_check evidence. */
export const BROWSER_RUNTIME_FAILURE_RE =
  /(Failed to load resource|net::ERR_|status of 404|\b404\b|ReferenceError|TypeError|SyntaxError|Total:\s*[1-9]\d*\s+error\(s\))/i

/** Shell commands that create/modify files. */
export const SHELL_FILE_WRITE_RE =
  /\b(?:tee|touch|cp|mv|install)\b|\bcat\b[^\n]*\s(?:>|>>|<<)\s*\S|(?:^|[^>])>{1,2}\s*\S/i

/** Shell in-place edit commands. */
export const SHELL_IN_PLACE_EDIT_RE =
  /\b(?:sed|perl|ruby)\b(?:(?![|;&\n]).)*\s-(?:[A-Za-z]*i|pi)(?:\b|=|['"])/i

/** Shell scaffold commands (npm create, cargo new, etc.). */
export const SHELL_SCAFFOLD_RE =
  /\b(?:npm\s+(?:create|init)|pnpm\s+(?:create|init)|yarn\s+create|bun\s+create|cargo\s+(?:new|init)|git\s+clone)\b/i

/** File path evidence in output text. */
export const FILE_ARTIFACT_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]+|\.{1,2}\/[^\s`'"]+|[a-z0-9_-]+(?:\/[a-z0-9_.-]+)+|[a-z0-9_.-]+\.[a-z0-9]{1,10})(?=$|[\s`'"])/i

/** Basic local file reference patterns found inside source content. */
export const LOCAL_ARTIFACT_REFERENCE_RE =
  /["'`](\.{1,2}\/[^"'`\s]+|[a-z0-9_.-]+\/[a-z0-9_./-]+|[a-z0-9_.-]+\.[a-z0-9]{1,10})["'`]/gi

/** Extensions likely to represent workspace artifacts. */
export const WORKSPACE_FILE_EXT_RE =
  /^(?:html?|css|js|mjs|cjs|jsx|ts|tsx|json|ya?ml|xml|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|map|md|txt|sql|sh|bash|zsh|py|rb|java|cs|go|rs|php)$/i

/** Ignore URL-like and anchor references that are not workspace artifacts. */
export const NON_WORKSPACE_REF_RE = /^(?:https?:|data:|mailto:|tel:|#)/i

/** Blocked/incomplete phase language. */
export const BLOCKED_PHASE_RE =
  /\b(?:blocked|stuck|cannot proceed|unable to continue|waiting for|depends on|prerequisite|not possible|impossible to|can't access|no access)\b/i

/** Output text that indicates the child is handing off unfinished implementation. */
export const UNRESOLVED_HANDOFF_RE =
  /\b(?:would you like to (?:proceed|continue)|should i (?:proceed|continue)|let me know if you (?:want|would like) me to (?:continue|proceed|implement)|partial(?:ly)? logic|partial(?:ly)? implementation|foundational partial implementation|this (?:project|implementation) is (?:a )?foundation|further refinements can be made|missing game mechanics|full compliance may require|may require additional (?:delegation|work|implementation)|not fully (?:implemented|complete)|deep validation(?:.*)?appears)\b/i

/** Narrative file claims without tool evidence. */
export const NARRATIVE_FILE_CLAIM_RE =
  /\b(?:created|wrote|saved|updated|implemented|scaffolded|generated)\b/i

/** Low-signal browser targets that don't count as meaningful evidence. */
export const LOW_SIGNAL_BROWSER_TARGETS = new Set(["about:blank"])

/** Browser tools that are meaningful (navigate, snapshot, run_code). */
export const MEANINGFUL_BROWSER_TOOLS = new Set([
  "browser_check",
])

/** Browser tools that are low-signal (tab list, console only). */
export const LOW_SIGNAL_BROWSER_TOOLS = new Set<string>([
  // Reserved for future browser sub-tools
])

// ── Task-intent classification regexes ──────────────────────────

export const RESEARCH_TASK_RE =
  /\b(?:research|find|search|look up|investigate|analyze|compare|explore|review|check|inspect|audit|summarize)\b/i

export const IMPLEMENTATION_TASK_RE =
  /\b(?:implement|build|create|scaffold|write|code|develop|add|make|construct|generate|produce|render|design)\b/i

export const VALIDATION_TASK_RE =
  /\b(?:test|validate|verify|check|confirm|ensure|assert|playtest|qa|e2e)\b/i

export const DOCUMENTATION_TASK_RE =
  /\b(?:document|readme|docs?|guide|instructions?|how[\s-]?to|architecture|design)\b/i

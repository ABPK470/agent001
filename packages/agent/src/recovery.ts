/**
 * Recovery hint system — ported from agenc-core's chat-executor-recovery.ts (2160 lines).
 *
 * After each tool call round, checks for known failure patterns and injects
 * targeted recovery hints so the LLM tries the RIGHT fix instead of blindly
 * retrying. Each hint is emitted at most once per run (tracked via emittedKeys).
 *
 * Covers 50+ failure patterns including:
 *   - File/path errors (ENOENT, permission denied, path not found)
 *   - Build errors (compiler diagnostics, linker, CMake, TypeScript)
 *   - Runtime errors (module not found, syntax error, timeout, OOM)
 *   - Test runner issues (watch mode, unsupported flags, assertion failures)
 *   - Package manager errors (npm lifecycle, missing scripts, workspace protocol)
 *   - Shell errors (heredoc syntax, builtins, glob expansion, grep shape)
 *   - Delegation errors (child agent decomposition, scope violations)
 *   - Code quality (JSON-escaped source literals, duplicate exports)
 *
 * @module
 */

import type { ToolResultEnvelope } from "./types.js"

// ============================================================================
// Types
// ============================================================================

export interface RecoveryHint {
  /** Dedup key — same key never emitted twice in one run. */
  key: string
  /** Human-readable advice injected as a system message. */
  message: string
}

export interface ToolCallRecord {
  name: string
  args: Record<string, unknown>
  result: string
  isError: boolean
  outcome?: ToolResultEnvelope
}

// ============================================================================
// Constants (ported from chat-executor-constants.ts)
// ============================================================================

/** Max chars for tool result previews. */
export const MAX_TOOL_RESULT_CHARS = 100_000
/** Max chars retained from a single tool result field. */
export const MAX_TOOL_RESULT_FIELD_CHARS = 100_000
/** Max consecutive identical failing tool calls before loop is broken. */
export const MAX_CONSECUTIVE_IDENTICAL_FAILURES = 3
/** Break tool loop after N rounds where every tool call failed. */
export const MAX_CONSECUTIVE_ALL_FAILED_ROUNDS = 3
/** Upper bound on additive runtime hint system messages per execution. */
export const DEFAULT_MAX_RUNTIME_SYSTEM_HINTS = 4
/** Break no-progress loops after repeated semantically equivalent rounds. */
export const MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS = 2
/** Default minimum verifier confidence for accepting subagent outputs. */
export const DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE = 0.65
/** Default max rounds for verifier/critique loops (initial round included). */
export const DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS = 2
/** Hard prompt-size guard (approx chars) to avoid provider context-length errors. */
export const MAX_PROMPT_CHARS_BUDGET = 500_000
/** Max chars retained for any user message. */
export const MAX_USER_MESSAGE_CHARS = 8_000
/** Hard cap for final assistant response size. */
export const MAX_FINAL_RESPONSE_CHARS = 24_000

/** Shell builtins that aren't standalone executables. */
export const SHELL_BUILTIN_COMMANDS = new Set([
  "set", "cd", "export", "source", "alias", "unalias", "unset",
  "shopt", "ulimit", "umask", "readonly", "declare", "typeset", "builtin",
])

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Scan a round of tool calls for known failure patterns.
 * Returns recovery hints that haven't been emitted yet.
 */
export function buildRecoveryHints(
  roundCalls: readonly ToolCallRecord[],
  emittedHints: Set<string>,
): RecoveryHint[] {
  const hints: RecoveryHint[] = []

  // Round-level hint (cross-call patterns)
  const roundHint = inferRoundRecoveryHint(roundCalls)
  if (roundHint && !emittedHints.has(roundHint.key)) {
    emittedHints.add(roundHint.key)
    hints.push(roundHint)
  }

  // Per-call hints
  for (const call of roundCalls) {
    const hint = inferRecoveryHint(call)
    if (!hint) continue
    if (emittedHints.has(hint.key)) continue
    emittedHints.add(hint.key)
    hints.push(hint)
  }

  // Max 4 hints per round to avoid flooding context
  return hints.slice(0, DEFAULT_MAX_RUNTIME_SYSTEM_HINTS)
}

/**
 * Build a semantic key for tool call dedup (ported from agenc-core).
 * Used for detecting semantically equivalent repeated calls.
 */
export function buildSemanticToolCallKey(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}:${normalizeSemanticValue(args)}`
}

function normalizeSemanticValue(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(normalizeSemanticValue).join(",")}]`
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map(k => `${k}:${normalizeSemanticValue(obj[k])}`).join(",")}}`
  }
  return String(value)
}

// ============================================================================
// Tool result parsing helpers (ported from chat-executor-tool-utils.ts)
// ============================================================================

/** Check if a tool call result represents a failure. */
export function didToolCallFail(isError: boolean, result: string): boolean {
  if (isError) return true
  try {
    const parsed = JSON.parse(result) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return isLikelyFailureText(result)
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.error === "string" && obj.error.trim().length > 0) return true
    if (typeof obj.error === "object" && obj.error !== null && !Array.isArray(obj.error)) {
      const nested = obj.error as Record<string, unknown>
      if (typeof nested.message === "string" && nested.message.trim().length > 0) return true
      if (typeof nested.code === "string" && nested.code.trim().length > 0) return true
    }
    if (obj.timedOut === true) return true
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return true
    if (typeof obj.stderr === "string" && /(?:error|fatal|failed)/i.test(obj.stderr)) return true
  } catch {
    return isLikelyFailureText(result)
  }
  return false
}

function isLikelyFailureText(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.startsWith("error") ||
    lower.includes("error executing tool") ||
    lower.includes("tool not found:") ||
    lower.includes("command not found") ||
    lower.includes("no such file") ||
    lower.includes("write rejected") ||
    lower.includes("written with errors") ||
    lower.includes("written with issues") ||
    lower.includes("issues detected")
  )
}

/** Parse JSON tool result, return null if not a valid JSON object. */
export function parseToolResultObject(result: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Extract the most useful failure text from a tool result. */
export function extractToolFailureText(record: ToolCallRecord): string {
  const parsed = parseToolResultObject(record.result)
  if (!parsed) return record.result

  const pieces: string[] = []
  const append = (v: unknown): void => {
    if (typeof v !== "string") return
    const trimmed = v.trim()
    if (trimmed.length === 0 || pieces.includes(trimmed)) return
    pieces.push(trimmed)
  }

  if (typeof parsed.error === "string") append(parsed.error)
  if (typeof parsed.error === "object" && parsed.error !== null && !Array.isArray(parsed.error)) {
    const e = parsed.error as Record<string, unknown>
    append(e.message); append(e.code)
  }
  if (typeof parsed.stderr === "string") append(parsed.stderr)
  if (typeof parsed.stdout === "string" && (parsed.timedOut === true || pieces.length > 0)) {
    append(parsed.stdout)
  }
  if (parsed.timedOut === true) pieces.unshift("Tool timed out before completing.")

  return pieces.length > 0 ? pieces.join("\n") : record.result
}

// ============================================================================
// Shell command helpers (ported from agenc-core)
// ============================================================================

function extractShellCommand(call: ToolCallRecord): string {
  const command = typeof call.args?.command === "string" ? call.args.command.trim() : ""
  const rawArgs = Array.isArray(call.args?.args)
    ? (call.args.args as unknown[]).filter((v): v is string => typeof v === "string")
    : []
  if (rawArgs.length === 0) return command
  return [command, ...rawArgs].filter(v => v.length > 0).join(" ").trim()
}

function commandBasename(command: string): string {
  return (command.trim().replace(/\\/g, "/").split("/").pop() ?? command).toLowerCase()
}

// ============================================================================
// Pattern detection helpers (ported from agenc-core)
// ============================================================================

function isWatchModeOutput(text: string): boolean {
  return /watch.*usage|press.*to|watching for/i.test(text)
    && /tests?\s+\d|suite/i.test(text)
}

function isWatchModeTestRunnerFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
  failureTextLower: string,
): boolean {
  if (call.name !== "run_command") return false
  if (!parsedResult || parsedResult.timedOut !== true) return false

  const command = extractShellCommand(call).toLowerCase()
  const stdout = typeof parsedResult.stdout === "string" ? parsedResult.stdout.toLowerCase() : ""
  const stderr = typeof parsedResult.stderr === "string" ? parsedResult.stderr.toLowerCase() : ""
  const watchSignal =
    stdout.includes("watching for file changes") ||
    stdout.includes("press h to show help") ||
    stdout.includes("press q to quit") ||
    stderr.includes("watching for file changes")
  if (!watchSignal) return false

  return (
    command.includes("vitest") || command.includes("jest") ||
    command.includes("npm") || command.includes("pnpm") ||
    command.includes("yarn") || command.includes("bun") ||
    command.includes("test") ||
    failureTextLower.includes("vitest") || failureTextLower.includes("jest")
  )
}

function isTimedOutNonWatchTestRunnerFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
  failureTextLower: string,
): boolean {
  if (!parsedResult || parsedResult.timedOut !== true) return false
  if (isWatchModeTestRunnerFailure(call, parsedResult, failureTextLower)) return false
  return isTestRunnerCommand(call, failureTextLower)
}

function isTestRunnerCommand(call: ToolCallRecord, failureTextLower: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  if (/\b(?:vitest|jest|pytest|mocha|ava)\b/.test(command)) return true
  if (/\b(?:npm|pnpm|yarn|bun)\b/.test(command) && /\btest\b/.test(command)) return true
  return failureTextLower.includes("vitest") || failureTextLower.includes("jest")
}

function isVitestUnsupportedThreadsFlagFailure(call: ToolCallRecord, failureTextLower: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  if (!command.includes("vitest") && !failureTextLower.includes("vitest")) return false
  if (!failureTextLower.includes("unknown option") || !failureTextLower.includes("--threads")) return false
  return command.includes("--threads") || command.includes("--no-threads")
}

function isUnsupportedWorkspaceProtocolFailure(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("unsupported url type \"workspace:\"") ||
    failureTextLower.includes("unsupported url type 'workspace:'") ||
    failureTextLower.includes("eunsupportedprotocol")
  )
}

function isRecursiveNpmInstallLifecycleFailure(call: ToolCallRecord, parsedResult: Record<string, unknown> | null): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  if (!command.includes("npm") || !command.includes("install")) return false

  const stdout = typeof parsedResult?.stdout === "string" ? parsedResult.stdout.toLowerCase() : ""
  const stderr = typeof parsedResult?.stderr === "string" ? parsedResult.stderr.toLowerCase() : ""
  const combined = `${stdout}\n${stderr}`
  return (
    />\s+.+?\s+install\s*\n>\s+npm install/.test(combined) ||
    (combined.includes("lifecycle script `install` failed") && combined.includes("> npm install"))
  )
}

function extractMissingNpmScriptName(failureText: string): string | undefined {
  const match = failureText.match(/missing script:\s*["'`]?([^"'`\n]+)["'`]?/i)
  return match?.[1]?.trim() || undefined
}

function isMissingNpmScriptFailure(call: ToolCallRecord, failureText: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  return command.includes("npm") && extractMissingNpmScriptName(failureText) !== undefined
}

function isMissingNpmWorkspaceFailure(call: ToolCallRecord, failureText: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  if (!command.includes("npm")) return false
  return /npm error no workspaces found:/i.test(failureText)
}

function isMissingLocalPackageDistFailure(failureText: string): boolean {
  return /cannot find (?:package|module)\s+['"][^'"]*\/node_modules\/[^'"]*\/dist\/[^'"]+['"]/i.test(failureText)
}

function isTypescriptRootDirScopeFailure(failureText: string): boolean {
  return /ts6059/i.test(failureText) && /is not under ['"`]rootdir['"`]/i.test(failureText)
}

function extractDuplicateExportName(failureText: string): string | undefined {
  for (const pattern of [
    /multiple exports with the same name ["'`](.+?)["'`]/i,
    /duplicate export(?:s)? ["'`](.+?)["'`]/i,
    /already exported a member named ['"`]([^'"`]+)['"`]/i,
  ]) {
    const match = failureText.match(pattern)
    const name = match?.[1]?.trim()
    if (name && name.length > 0) return name
  }
  return undefined
}

function isDuplicateExportFailure(failureText: string): boolean {
  return extractDuplicateExportName(failureText) !== undefined || /ts2308/i.test(failureText)
}

function isJsonEscapedSourceLiteralFailure(failureText: string): boolean {
  const hasCompilerStylePath = /(?:^|\s|["'`])[^"'`\s]+\.(?:rs|c|cc|cpp|h|hpp|ts|tsx|js|jsx|py):\d+/i.test(failureText)
  const hasEscapeTokenSignal =
    failureText.toLowerCase().includes("unknown start of token: \\") ||
    failureText.toLowerCase().includes("unknown character escape") ||
    failureText.toLowerCase().includes("unterminated double quote string")
  const hasEscapedLiteralSignal =
    failureText.includes('\\"') || failureText.includes("\\n") || failureText.includes("\\t")
  return hasCompilerStylePath && hasEscapeTokenSignal && hasEscapedLiteralSignal
}

function isShellExecutionAnomalyFailure(failureText: string): boolean {
  return /(?:^|\n)(?:[^:\n]+:\s+line\s+\d+:\s+)?(?:(?:ba|z|k)?sh|cd|pushd|popd|source|\.)[^:\n]*:\s+.*(?:no such file or directory|command not found|not found|permission denied|not a directory)/i.test(failureText)
}

function extractCompilerDiagnosticLocation(failureText: string): string | undefined {
  const match = failureText.match(
    /(^|\n)([^:\n]+\.(?:c|cc|cpp|cxx|h|hpp|hh|m|mm|rs|go|ts|tsx|js|jsx|py)):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?error:/i,
  )
  const file = match?.[2]?.trim()
  const line = match?.[3]?.trim()
  const column = match?.[4]?.trim()
  if (!file || !line) return undefined
  return `${file}:${line}${column ? `:${column}` : ""}`
}

function extractUnknownTypeNameFromCompilerFailure(failureText: string): string | undefined {
  return failureText.match(/\bunknown type name ['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?/i)?.[1]?.trim()
}

function extractCompilerSuggestedName(failureText: string): string | undefined {
  return failureText.match(/\bdid you mean ['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?/i)?.[1]?.trim()
}

function isHeaderTypeOrderingCompilerFailure(failureText: string): boolean {
  return (
    /\bunknown type name ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(failureText) ||
    /\bfield has incomplete type\b/i.test(failureText) ||
    (/\bunknown type\b/i.test(failureText) && /\b(?:struct|typedef|enum|union|header)\b/i.test(failureText))
  )
}

function isCompilerInterfaceDriftFailure(failureText: string): boolean {
  return (
    /\bhas no member named ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(failureText) ||
    /\bdid you mean ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(failureText) ||
    /\bincompatible types when assigning to type\b/i.test(failureText) ||
    /\bundeclared\b.*\bdid you mean\b/i.test(failureText)
  )
}

function isCompilerDiagnosticFailure(call: ToolCallRecord, failureText: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  const looksLikeBuild = /\b(?:cmake|ctest|make|ninja|meson|gcc|g\+\+|clang|clang\+\+|cc|c\+\+|tsc|cargo|go build|rustc)\b/.test(command)
  const looksLikeScript = /\b(?:ba|z|k)?sh\s+[^\s]+\.(?:sh|bash|zsh)\b/i.test(command)
  return (looksLikeBuild || looksLikeScript) && extractCompilerDiagnosticLocation(failureText) !== undefined
}

function isPackagePathNotExportedFailure(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("err_package_path_not_exported") ||
    failureTextLower.includes("no \"exports\" main defined")
  )
}

function hasBrokenHeredocConjunctionShape(args: Record<string, unknown> | undefined, failureTextLower: string): boolean {
  if (!failureTextLower.includes("syntax error near unexpected token")) return false
  const command = typeof args?.command === "string" ? args.command : ""
  if (!command.includes("<<")) return false
  return /\n\s*(?:&&|\|\||;)\s+\S/.test(command)
}

function hasExtendedGrepPatternWithoutFlag(args: Record<string, unknown> | undefined): boolean {
  const rawArgs = Array.isArray(args?.args)
    ? (args!.args as unknown[]).filter((v): v is string => typeof v === "string")
    : []
  if (rawArgs.length === 0) return false
  const hasExtendedFlag = rawArgs.some(v => v === "-E" || v === "-P")
  if (hasExtendedFlag) return false
  return rawArgs.some(v => !v.startsWith("-") && v.includes("|"))
}

function isLikelyGrepOperandShapeFailure(call: ToolCallRecord, failureTextLower: string): boolean {
  if (call.name !== "run_command") return false
  const command = typeof call.args?.command === "string" ? call.args.command : ""
  if (commandBasename(command) !== "grep") return false
  if (failureTextLower.includes("no such file or directory")) return true
  return hasExtendedGrepPatternWithoutFlag(call.args)
}

function isLikelyLiteralGlobFailure(call: ToolCallRecord, failureTextLower: string): boolean {
  if (call.name !== "run_command") return false
  if (!failureTextLower.includes("no such file or directory") && !failureTextLower.includes("cannot access")) return false
  const rawArgs = Array.isArray(call.args?.args)
    ? (call.args.args as unknown[]).filter((v): v is string => typeof v === "string")
    : []
  return rawArgs.some(v => !v.startsWith("-") && /[?[*\]]/.test(v) && (v.includes("/") || v.includes(".")))
}

function extractSpawnEnoentCommand(failureText: string): string | undefined {
  const match = failureText.match(/spawn\s+([^\s]+)\s+enoent/i)
  return match?.[1]?.trim() || undefined
}

// ============================================================================
// Round-level hints (cross-call patterns — ported from agenc-core)
// ============================================================================

function inferRoundRecoveryHint(roundCalls: readonly ToolCallRecord[]): RecoveryHint | undefined {
  // Detect delegation results that indicate the child needs decomposition
  const delegationNeedsDecomposition = roundCalls.find(call => {
    if (call.name !== "delegate" && call.name !== "delegate_parallel") return false
    if (!call.result.includes("Agent stopped after")) return false
    return true
  })
  if (delegationNeedsDecomposition) {
    return {
      key: "delegation-child-exhausted-budget",
      message:
        "A delegated child agent exhausted its iteration budget without completing the task. " +
        "The objective was too large for a single child. Split it into smaller, more focused " +
        "delegate calls, each with a narrower scope and clear acceptance criteria. " +
        "Do not retry the same combined task — decompose it.",
    }
  }

  // Detect all-fail rounds
  const allFailed = roundCalls.length > 0 && roundCalls.every(c => didToolCallFail(c.isError, c.result))
  if (allFailed && roundCalls.length >= 2) {
    return {
      key: "round-all-tools-failed",
      message:
        "Every tool call in this round failed. Stop and reassess your entire approach. " +
        "You may be working in the wrong directory, missing dependencies, or using the wrong tools. " +
        "Use list_directory or read_file to understand your current state before trying again.",
    }
  }

  return undefined
}

// ============================================================================
// Per-call recovery hint inference (ported from agenc-core's inferRecoveryHint)
// ============================================================================

function inferRecoveryHint(call: ToolCallRecord): RecoveryHint | undefined {
  const result = call.result
  const resultLower = result.toLowerCase()
  const parsedResult = parseToolResultObject(result)
  const failureText = extractToolFailureText(call)
  const failureTextLower = failureText.toLowerCase()

  // ── Success-path hints (detect problems in non-error results) ─────

  // Watch mode detection on successful-but-hanging test commands
  if (!call.isError && call.name === "run_command" && isWatchModeOutput(resultLower)) {
    return {
      key: "test-runner-watch-mode",
      message:
        "This test command entered interactive watch mode and may have timed out. " +
        "Retry with a non-interactive single-run invocation. " +
        "For Vitest: `vitest run` or `vitest --run`. " +
        "For Jest: `CI=1 npm test` or `jest --runInBand`. " +
        "For pytest: remove `-s` interactive flags. " +
        "Only append npm `--` flags when the underlying runner supports them.",
    }
  }

  // Shell command succeeded but stderr shows real errors
  if (!call.isError && call.name === "run_command" && isShellExecutionAnomalyFailure(failureText)) {
    return {
      key: "shell-execution-anomaly",
      message:
        "This shell command printed a real error on stderr even though exits code was 0. " +
        "Treat it as failed. Fix the cwd/path/script invocation before rerunning. " +
        "For scripts that use relative paths, invoke from the workspace root.",
    }
  }

  // ── Failure-path hints ────────────────────────────────────────

  if (!call.isError && !resultLower.includes("error") && !resultLower.includes("fail")) return undefined

  // ENOENT / file not found
  if (/enoent|no such file or directory/i.test(result)) {
    const match = result.match(/no such file or directory[,:]?\s*'?([^'\n]+)/i)
    const missingPath = match?.[1]?.trim()
    return {
      key: `enoent:${missingPath ?? "unknown"}`,
      message:
        `File or directory not found: ${missingPath ?? "(see error)"}. ` +
        "Use list_directory or `find` to discover what actually exists before retrying. " +
        "Do not guess paths — verify them first.",
    }
  }

  // Permission denied
  if (/permission denied|eacces/i.test(result)) {
    return {
      key: "permission-denied",
      message:
        "Permission denied. If this is a script, try `chmod +x` first. " +
        "If writing to a system directory, use a local path instead. " +
        "Do NOT use sudo unless explicitly allowed.",
    }
  }

  // Port already in use
  if (/eaddrinuse|address already in use|port.*already.*in.*use/i.test(result)) {
    const portMatch = result.match(/port\s+(\d+)/i) ?? result.match(/:\s*(\d{4,5})/i)
    const port = portMatch?.[1] ?? "the port"
    return {
      key: `port-in-use:${port}`,
      message:
        `Port ${port} is already in use. Either kill the existing process ` +
        `(\`lsof -i :${port}\` then \`kill <PID>\`) or use a different port.`,
    }
  }

  // Module not found / import errors
  if (/cannot find module|module not found|no module named/i.test(result)) {
    const modMatch = result.match(/(?:cannot find module|module not found|no module named)\s*'?([^'\s\n]+)/i)
    const moduleName = modMatch?.[1]
    return {
      key: `module-not-found:${moduleName ?? "unknown"}`,
      message:
        `Module "${moduleName ?? "(see error)"}" not found. ` +
        "Check: (1) Is it installed? Run `npm install` / `pip install`. " +
        "(2) Is the import path correct? Check for typos and relative vs absolute paths. " +
        "(3) Does the file you're importing from actually export that symbol?",
    }
  }

  // Syntax errors in code
  if (/syntaxerror|unexpected token|parsing error/i.test(result)) {
    return {
      key: "syntax-error",
      message:
        "Syntax error in your code. Read the error carefully — it tells you the exact line and position. " +
        "Use read_file to check that specific location. Fix the EXACT syntax issue; " +
        "do NOT rewrite the entire file. Common causes: missing brackets, unclosed strings, " +
        "misplaced commas, mixing tabs and spaces.",
    }
  }

  // TypeScript type errors
  if (/ts\d{4}:|type.*is not assignable|property.*does not exist on type/i.test(result)) {
    return {
      key: "typescript-type-error",
      message:
        "TypeScript compilation error. Read the type error carefully. " +
        "Fix the specific type mismatch — do not add `as any` or `@ts-ignore`. " +
        "If you need to understand the expected types, read the type definitions first.",
    }
  }

  // npm/yarn install failures
  if (/npm err!|yarn error|eperm|eresolve|peer dep/i.test(result)) {
    return {
      key: "npm-install-failure",
      message:
        "Package installation failed. Check the error: " +
        "ERESOLVE = dependency conflict (try `--legacy-peer-deps`). " +
        "EPERM = permission issue. " +
        "If a package doesn't exist, verify the exact package name on npm.",
    }
  }

  // Python traceback
  if (/traceback \(most recent call last\)/i.test(result)) {
    return {
      key: "python-traceback",
      message:
        "Python raised an exception. Read the LAST line of the traceback — that's the actual error. " +
        "The lines above show the call stack. Fix the specific error; do not rewrite the entire script.",
    }
  }

  // Command not found
  if (/command not found|not recognized as.*command/i.test(result)) {
    const cmdMatch = result.match(/(?:command not found|not recognized).*?:\s*(\S+)/i)
      ?? result.match(/(\S+):\s*command not found/i)
    const cmd = cmdMatch?.[1]
    return {
      key: `command-not-found:${cmd ?? "unknown"}`,
      message:
        `Command "${cmd ?? "(see error)"}" not found. ` +
        "Check: (1) Is it installed? (2) Is it in PATH? Use `which` to verify. " +
        "(3) For npm packages, try `npx <command>` instead. " +
        "(4) For Python, try `python -m <module>`.",
    }
  }

  // Compilation/linker errors
  if (/undefined reference|linker error|cannot find -l|ld: |error\[E\d+\]/i.test(result)) {
    return {
      key: "compilation-linker-error",
      message:
        "Compilation or linker error. Read the error to identify the missing symbol or library. " +
        "For undefined references: check that all source files are included in the build. " +
        "For missing libraries: install the development package (e.g., `-dev` or `-devel` suffix). " +
        "Do not rewrite working code to fix a build configuration issue.",
    }
  }

  // Test assertion failures
  if (/assertion.*failed|expect\(.*\)\.to|assert.*error|test.*failed/i.test(result)) {
    return {
      key: "test-assertion-failure",
      message:
        "A test assertion failed. Read the expected vs actual values carefully. " +
        "Fix the implementation code to match the expected behavior — do NOT fix the test " +
        "unless the test itself is wrong. Focus on the FIRST failing assertion.",
    }
  }

  // JSON parse errors
  if (/unexpected token.*json|json\.parse|invalid json|json syntax/i.test(result)) {
    return {
      key: "json-parse-error",
      message:
        "JSON parsing failed. The data is not valid JSON. Common causes: " +
        "trailing commas, single quotes instead of double, unquoted keys, " +
        "or the response is HTML/text instead of JSON. Inspect the raw data first.",
    }
  }

  // Timeout errors
  if (/etimedout|esockettimedout|timeout.*exceeded|timed?\s*out/i.test(result)) {
    return {
      key: "timeout-error",
      message:
        "Operation timed out. The process likely hung. Common causes: " +
        "infinite loop, unresolved promise, open handle, or waiting for user input. " +
        "Do NOT increase the timeout. Inspect the code for hanging operations.",
    }
  }

  // Heap out of memory
  if (/heap out of memory|javascript heap|fatal error.*allocation/i.test(result)) {
    return {
      key: "out-of-memory",
      message:
        "Process ran out of memory. The code is likely creating too much data at once. " +
        "Use streaming, pagination, or process data in chunks instead of loading everything into memory.",
    }
  }

  // ── Advanced patterns (ported from agenc-core) ────────────────

  // Watch mode test runner failure with timeout
  if (isWatchModeTestRunnerFailure(call, parsedResult, failureTextLower)) {
    return {
      key: "test-runner-watch-mode-timeout",
      message:
        "This test command entered interactive watch mode and timed out. " +
        "Retry with a non-interactive single-run invocation. " +
        "For Vitest: `vitest run` or `vitest --run`. " +
        "For Jest: `CI=1 npm test` or `jest --runInBand`. " +
        "Only append npm `--` flags when the underlying runner supports them.",
    }
  }

  // Non-watch test timeout
  if (isTimedOutNonWatchTestRunnerFailure(call, parsedResult, failureTextLower)) {
    return {
      key: "test-runner-timeout",
      message:
        "This non-interactive test command timed out. " +
        "A test or code path likely hung (infinite loop, unresolved promise, or open handle). " +
        "Do not keep retrying the same command. Inspect the source and tests, fix the hang, " +
        "then rerun the minimal single-run test command.",
    }
  }

  // Vitest unsupported --threads flag
  if (isVitestUnsupportedThreadsFlagFailure(call, failureTextLower)) {
    return {
      key: "vitest-unsupported-threads-flag",
      message:
        "Vitest rejected an unsupported thread flag. Do not invent `--threads` or `--no-threads`. " +
        "Keep the command in single-run mode (`vitest run` or `vitest --run`). " +
        "If worker strategy matters, use `--pool=<threads|forks>` or project config instead.",
    }
  }

  // Workspace protocol unsupported
  if (isUnsupportedWorkspaceProtocolFailure(failureTextLower)) {
    return {
      key: "workspace-protocol-unsupported",
      message:
        "This package manager rejected `workspace:*`. Do not assume workspace protocol support. " +
        "Rewrite the local dependency to a host-compatible specifier, then rerun `npm install`.",
    }
  }

  // Recursive npm install lifecycle
  if (isRecursiveNpmInstallLifecycleFailure(call, parsedResult)) {
    return {
      key: "recursive-npm-install-lifecycle",
      message:
        "This project defines an `install` lifecycle that recursively reruns `npm install`, causing a loop. " +
        "Remove or rename the recursive `install` script in `package.json`, then rerun `npm install`.",
    }
  }

  // Missing npm script
  if (isMissingNpmScriptFailure(call, failureText)) {
    const scriptName = extractMissingNpmScriptName(failureText) ?? "requested"
    return {
      key: `missing-npm-script:${scriptName.toLowerCase()}`,
      message:
        `The current package.json does not define npm script \`${scriptName}\`. ` +
        "Inspect package.json, add the missing script, or run the correct command directly.",
    }
  }

  // Missing npm workspace
  if (isMissingNpmWorkspaceFailure(call, failureText)) {
    return {
      key: "missing-npm-workspace",
      message:
        "npm could not match the `--workspace` selector. " +
        "Inspect root `package.json` workspaces and each package `name`, then rerun with exact workspace names " +
        "or run the command from the matching workspace cwd.",
    }
  }

  // Missing local package dist
  if (isMissingLocalPackageDistFailure(failureText)) {
    return {
      key: "local-package-dist-missing",
      message:
        "This local package link resolved to a `dist/*` entry that doesn't exist yet. " +
        "Build the dependency package first, then rerun the command.",
    }
  }

  // TypeScript rootDir scope error
  if (isTypescriptRootDirScopeFailure(failureText)) {
    return {
      key: "typescript-rootdir-scope",
      message:
        "This TypeScript config includes files outside `rootDir`. " +
        "Either remove the restrictive `rootDir`, exclude config files from tsconfig, " +
        "or move Node-side config files into a separate `tsconfig.node.json`.",
    }
  }

  // Duplicate export
  if (isDuplicateExportFailure(failureText)) {
    const exportName = extractDuplicateExportName(failureText) ?? "the symbol"
    return {
      key: `duplicate-export:${exportName.toLowerCase()}`,
      message:
        `Module exports \`${exportName}\` more than once. ` +
        "If the declaration already has an export modifier, remove the extra re-export. " +
        "After editing, rerun the build/test command.",
    }
  }

  // JSON-escaped source literal
  if (isJsonEscapedSourceLiteralFailure(failureText)) {
    return {
      key: "json-escaped-source-literal",
      message:
        "JSON escape sequences like `\\\\\"` or `\\\\n` were written into source code. " +
        "Re-read the failing source file, replace the escaped text with raw source code, " +
        "and pass file contents directly instead of JSON-encoded representations.",
    }
  }

  // Package path not exported
  if (isPackagePathNotExportedFailure(failureTextLower)) {
    return {
      key: "package-exports-mismatch",
      message:
        "This package's `exports` map does not match how the command is loading it. " +
        "Inspect `package.json` `exports`/`main`/`types`, then retry with an entry point that matches the package format.",
    }
  }

  // Compiler diagnostic with location
  if (isCompilerDiagnosticFailure(call, failureText)) {
    const location = extractCompilerDiagnosticLocation(failureText)
    const unknownTypeName = extractUnknownTypeNameFromCompilerFailure(failureText)
    const suggestedName = extractCompilerSuggestedName(failureText)

    if (isCompilerInterfaceDriftFailure(failureText)) {
      return {
        key: location ? `compiler-interface-drift:${location.toLowerCase()}` : "compiler-interface-drift",
        message:
          "The compiler is reporting cross-file interface drift" +
          (location ? ` at \`${location}\`` : "") +
          (suggestedName ? ` — did you mean \`${suggestedName}\`?` : "") +
          ". Read the cited header plus every source file that uses it, align the type/member names, " +
          "and only rerun the build after the full interface is consistent.",
      }
    }
    if (isHeaderTypeOrderingCompilerFailure(failureText)) {
      return {
        key: location ? `compiler-header-ordering:${location.toLowerCase()}` : "compiler-header-ordering",
        message:
          "The compiler is reporting a header/type-ordering error" +
          (location ? ` at \`${location}\`` : "") +
          (unknownTypeName ? ` involving \`${unknownTypeName}\`` : "") +
          ". Move the type definition or forward declaration before the first use, then rebuild.",
      }
    }
    return {
      key: location ? `compiler-diagnostic:${location.toLowerCase()}` : "compiler-diagnostic",
      message:
        "The compiler identified a concrete source location" +
        (location ? ` (\`${location}\`)` : "") +
        ". Stop rerunning the same build command. Read and edit the cited file, fix the error, " +
        "and only rerun the build after the source change is in place.",
    }
  }

  // Heredoc conjunction syntax error
  if (hasBrokenHeredocConjunctionShape(call.args, failureTextLower)) {
    return {
      key: "heredoc-conjunction-shape",
      message:
        "This shell script put `&&`, `||`, or `;` on a new line after a heredoc terminator, " +
        "which is invalid shell syntax. Split the follow-up command into a separate tool call, " +
        "or use write_file for file contents instead of shell heredocs.",
    }
  }

  // Grep operand shape issues
  if (isLikelyGrepOperandShapeFailure(call, failureTextLower)) {
    return {
      key: "grep-shape",
      message:
        "For code search, prefer `grep -r pattern path` or `rg pattern path`. " +
        "When using alternation like `foo|bar`, add `-E` flag. " +
        "Without file paths, grep reads stdin — pair `--include` with `-r` and a directory.",
    }
  }

  // Literal glob not expanded
  if (isLikelyLiteralGlobFailure(call, failureTextLower)) {
    return {
      key: "literal-glob-operand",
      message:
        "Shell globs like `*.ts` may not expand in direct mode. " +
        "Enumerate matches with `find` or `rg --files` first, or pass the full command as a shell string.",
    }
  }

  // Shell builtin used as executable
  const spawnEnoentCommand = extractSpawnEnoentCommand(failureText)
  if (spawnEnoentCommand) {
    const missingCommand = commandBasename(spawnEnoentCommand)
    if (SHELL_BUILTIN_COMMANDS.has(missingCommand)) {
      return {
        key: "shell-builtin",
        message:
          `Shell builtins like \`${missingCommand}\` are not standalone executables. ` +
          "Run the full shell command as a single string.",
      }
    }
    return {
      key: `missing-command:${missingCommand}`,
      message:
        `Executable \`${missingCommand}\` was not found on PATH. ` +
        "If it's a project-local tool, try `npx ${missingCommand}` or `npm exec -- ${missingCommand}`. " +
        "Otherwise install it first.",
    }
  }

  // Browser check 404 / network failures
  if (call.name === "browser_check" && /404|ERR_ABORTED|Failed to load resource|net::/i.test(result)) {
    return {
      key: "browser-check-404",
      message:
        "browser_check found 404 (Not Found) errors for CSS, JS, or other assets. " +
        "The static server is rooted at the HTML file's parent directory. " +
        "All <script src>, <link href>, and image paths in the HTML must exist relative to that directory. " +
        "Steps to fix: (1) Use list_directory to check what files actually exist in the HTML file's directory. " +
        "(2) Either move the missing files to the expected paths, or update the HTML references to match. " +
        "(3) If you used subdirectories like css/ or js/, make sure those directories and files exist. " +
        "Do NOT just re-run browser_check — fix the file structure or HTML first.",
    }
  }

  // Delegation results that failed
  if (call.name === "delegate" || call.name === "delegate_parallel") {
    if (resultLower.includes("delegation failed")) {
      return {
        key: "delegation-failed",
        message:
          "A delegated child task failed. Read the failure reason carefully. " +
          "Check if the goal was clear enough and had all necessary context. " +
          "Retry with a more specific goal, or do the task directly if it's simple enough.",
      }
    }
    if (resultLower.includes("agent stopped after") && resultLower.includes("iteration")) {
      return {
        key: "delegation-budget-exhausted",
        message:
          "The child agent exhausted its iteration budget. The task was too large. " +
          "Increase the child budget when the work is a single cohesive owned implementation, or split only along real ownership boundaries when the task mixes unrelated concerns. " +
          "Do NOT micro-split solely to chase a tiny iteration count.",
      }
    }
  }

  return undefined
}

// ============================================================================
// Quality proxy (ported from agenc-core's computeQualityProxy)
// ============================================================================

export interface QualityProxyInput {
  readonly completionState: "completed" | "needs_verification" | "partial" | "blocked"
  readonly verifierPerformed: boolean
  readonly verifierOverall: "pass" | "retry" | "fail" | "skipped"
  readonly failedToolCalls: number
}

/** Compute a 0–1 quality proxy score from execution outcome signals. */
export function computeQualityProxy(input: QualityProxyInput): number {
  const base = input.completionState === "completed" ? 0.85
    : input.completionState === "needs_verification" ? 0.6
    : input.completionState === "partial" ? 0.45
    : 0.25
  const verifierBonus = input.verifierPerformed
    ? (input.verifierOverall === "pass" ? 0.1 : input.verifierOverall === "retry" ? 0 : -0.15)
    : 0
  const failurePenalty = Math.min(0.25, input.failedToolCalls * 0.05)
  return Math.max(0, Math.min(1, base + verifierBonus - failurePenalty))
}

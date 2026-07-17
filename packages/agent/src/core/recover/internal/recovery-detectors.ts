/**
 * Recovery pattern detectors — boolean helper functions that identify
 * specific failure patterns in tool call results.
 *
 * Extracted from recovery.ts. These are pure functions with no side effects.
 */

import type { ToolCallRecord } from "../../../tools/index.js"

// ============================================================================
// Shell command helpers
// ============================================================================

export function extractShellCommand(call: ToolCallRecord): string {
  const command = typeof call.args?.command === "string" ? call.args.command.trim() : ""
  const rawArgs = Array.isArray(call.args?.args)
    ? (call.args.args as unknown[]).filter((v): v is string => typeof v === "string")
    : []
  if (rawArgs.length === 0) return command
  return [command, ...rawArgs]
    .filter((v) => v.length > 0)
    .join(" ")
    .trim()
}

export function commandBasename(command: string): string {
  return (command.trim().replace(/\\/g, "/").split("/").pop() ?? command).toLowerCase()
}

// ============================================================================
// Pattern detection helpers
// ============================================================================

export function isWatchModeOutput(text: string): boolean {
  return /watch.*usage|press.*to|watching for/i.test(text) && /tests?\s+\d|suite/i.test(text)
}

export function isWatchModeTestRunnerFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
  failureTextLower: string
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
    command.includes("vitest") ||
    command.includes("jest") ||
    command.includes("npm") ||
    command.includes("pnpm") ||
    command.includes("yarn") ||
    command.includes("bun") ||
    command.includes("test") ||
    failureTextLower.includes("vitest") ||
    failureTextLower.includes("jest")
  )
}

export function isTimedOutNonWatchTestRunnerFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
  failureTextLower: string
): boolean {
  if (!parsedResult || parsedResult.timedOut !== true) return false
  if (isWatchModeTestRunnerFailure(call, parsedResult, failureTextLower)) return false
  return isTestRunnerCommand(call, failureTextLower)
}

export function isTestRunnerCommand(call: ToolCallRecord, failureTextLower: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  if (/\b(?:vitest|jest|pytest|mocha|ava)\b/.test(command)) return true
  if (/\b(?:npm|pnpm|yarn|bun)\b/.test(command) && /\btest\b/.test(command)) return true
  return failureTextLower.includes("vitest") || failureTextLower.includes("jest")
}

export function isVitestUnsupportedThreadsFlagFailure(
  call: ToolCallRecord,
  failureTextLower: string
): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  if (!command.includes("vitest") && !failureTextLower.includes("vitest")) return false
  if (!failureTextLower.includes("unknown option") || !failureTextLower.includes("--threads")) return false
  return command.includes("--threads") || command.includes("--no-threads")
}

export function isUnsupportedWorkspaceProtocolFailure(failureTextLower: string): boolean {
  return (
    failureTextLower.includes('unsupported url type "workspace:"') ||
    failureTextLower.includes("unsupported url type 'workspace:'") ||
    failureTextLower.includes("eunsupportedprotocol")
  )
}

export function isRecursiveNpmInstallLifecycleFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null
): boolean {
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

export function extractMissingNpmScriptName(failureText: string): string | undefined {
  const match = failureText.match(/missing script:\s*["'`]?([^"'`\n]+)["'`]?/i)
  return match?.[1]?.trim() || undefined
}

export function isMissingNpmScriptFailure(call: ToolCallRecord, failureText: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  return command.includes("npm") && extractMissingNpmScriptName(failureText) !== undefined
}

export function isMissingNpmWorkspaceFailure(call: ToolCallRecord, failureText: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  if (!command.includes("npm")) return false
  return /npm error no workspaces found:/i.test(failureText)
}

export function isMissingLocalPackageDistFailure(failureText: string): boolean {
  return /cannot find (?:package|module)\s+['"][^'"]*\/node_modules\/[^'"]*\/dist\/[^'"]+['"]/i.test(
    failureText
  )
}

export function isTypescriptRootDirScopeFailure(failureText: string): boolean {
  return /ts6059/i.test(failureText) && /is not under ['"`]rootdir['"`]/i.test(failureText)
}

export function extractDuplicateExportName(failureText: string): string | undefined {
  for (const pattern of [
    /multiple exports with the same name ["'`](.+?)["'`]/i,
    /duplicate export(?:s)? ["'`](.+?)["'`]/i,
    /already exported a member named ['"`]([^'"`]+)['"`]/i
  ]) {
    const match = failureText.match(pattern)
    const name = match?.[1]?.trim()
    if (name && name.length > 0) return name
  }
  return undefined
}

export function isDuplicateExportFailure(failureText: string): boolean {
  return extractDuplicateExportName(failureText) !== undefined || /ts2308/i.test(failureText)
}

export function isJsonEscapedSourceLiteralFailure(failureText: string): boolean {
  const hasCompilerStylePath = /(?:^|\s|["'`])[^"'`\s]+\.(?:rs|c|cc|cpp|h|hpp|ts|tsx|js|jsx|py):\d+/i.test(
    failureText
  )
  const hasEscapeTokenSignal =
    failureText.toLowerCase().includes("unknown start of token: \\") ||
    failureText.toLowerCase().includes("unknown character escape") ||
    failureText.toLowerCase().includes("unterminated double quote string")
  const hasEscapedLiteralSignal =
    failureText.includes('\\"') || failureText.includes("\\n") || failureText.includes("\\t")
  return hasCompilerStylePath && hasEscapeTokenSignal && hasEscapedLiteralSignal
}

export function isShellExecutionAnomalyFailure(failureText: string): boolean {
  return /(?:^|\n)(?:[^:\n]+:\s+line\s+\d+:\s+)?(?:(?:ba|z|k)?sh|cd|pushd|popd|source|\.)[^:\n]*:\s+.*(?:no such file or directory|command not found|not found|permission denied|not a directory)/i.test(
    failureText
  )
}

export function extractCompilerDiagnosticLocation(failureText: string): string | undefined {
  const match = failureText.match(
    /(^|\n)([^:\n]+\.(?:c|cc|cpp|cxx|h|hpp|hh|m|mm|rs|go|ts|tsx|js|jsx|py)):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?error:/i
  )
  const file = match?.[2]?.trim()
  const line = match?.[3]?.trim()
  const column = match?.[4]?.trim()
  if (!file || !line) return undefined
  return `${file}:${line}${column ? `:${column}` : ""}`
}

export function extractUnknownTypeNameFromCompilerFailure(failureText: string): string | undefined {
  return failureText.match(/\bunknown type name ['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?/i)?.[1]?.trim()
}

export function extractCompilerSuggestedName(failureText: string): string | undefined {
  return failureText.match(/\bdid you mean ['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?/i)?.[1]?.trim()
}

export function isHeaderTypeOrderingCompilerFailure(failureText: string): boolean {
  return (
    /\bunknown type name ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(failureText) ||
    /\bfield has incomplete type\b/i.test(failureText) ||
    (/\bunknown type\b/i.test(failureText) && /\b(?:struct|typedef|enum|union|header)\b/i.test(failureText))
  )
}

export function isCompilerInterfaceDriftFailure(failureText: string): boolean {
  return (
    /\bhas no member named ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(failureText) ||
    /\bdid you mean ['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/i.test(failureText) ||
    /\bincompatible types when assigning to type\b/i.test(failureText) ||
    /\bundeclared\b.*\bdid you mean\b/i.test(failureText)
  )
}

export function isCompilerDiagnosticFailure(call: ToolCallRecord, failureText: string): boolean {
  if (call.name !== "run_command") return false
  const command = extractShellCommand(call).toLowerCase()
  const looksLikeBuild =
    /\b(?:cmake|ctest|make|ninja|meson|gcc|g\+\+|clang|clang\+\+|cc|c\+\+|tsc|cargo|go build|rustc)\b/.test(
      command
    )
  const looksLikeScript = /\b(?:ba|z|k)?sh\s+[^\s]+\.(?:sh|bash|zsh)\b/i.test(command)
  return (looksLikeBuild || looksLikeScript) && extractCompilerDiagnosticLocation(failureText) !== undefined
}

export function isPackagePathNotExportedFailure(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("err_package_path_not_exported") ||
    failureTextLower.includes('no "exports" main defined')
  )
}

export function hasBrokenHeredocConjunctionShape(
  args: Record<string, unknown> | undefined,
  failureTextLower: string
): boolean {
  if (!failureTextLower.includes("syntax error near unexpected token")) return false
  const command = typeof args?.command === "string" ? args.command : ""
  if (!command.includes("<<")) return false
  return /\n\s*(?:&&|\|\||;)\s+\S/.test(command)
}

export function hasExtendedGrepPatternWithoutFlag(args: Record<string, unknown> | undefined): boolean {
  const rawArgs = Array.isArray(args?.args)
    ? (args!.args as unknown[]).filter((v): v is string => typeof v === "string")
    : []
  if (rawArgs.length === 0) return false
  const hasExtendedFlag = rawArgs.some((v) => v === "-E" || v === "-P")
  if (hasExtendedFlag) return false
  return rawArgs.some((v) => !v.startsWith("-") && v.includes("|"))
}

export function isLikelyGrepOperandShapeFailure(call: ToolCallRecord, failureTextLower: string): boolean {
  if (call.name !== "run_command") return false
  const command = typeof call.args?.command === "string" ? call.args.command : ""
  if (commandBasename(command) !== "grep") return false
  if (failureTextLower.includes("no such file or directory")) return true
  return hasExtendedGrepPatternWithoutFlag(call.args)
}

export function isLikelyLiteralGlobFailure(call: ToolCallRecord, failureTextLower: string): boolean {
  if (call.name !== "run_command") return false
  if (!failureTextLower.includes("no such file or directory") && !failureTextLower.includes("cannot access"))
    return false
  const rawArgs = Array.isArray(call.args?.args)
    ? (call.args.args as unknown[]).filter((v): v is string => typeof v === "string")
    : []
  return rawArgs.some((v) => !v.startsWith("-") && /[?[*\]]/.test(v) && (v.includes("/") || v.includes(".")))
}

export function extractSpawnEnoentCommand(failureText: string): string | undefined {
  const match = failureText.match(/spawn\s+([^\s]+)\s+enoent/i)
  return match?.[1]?.trim() || undefined
}

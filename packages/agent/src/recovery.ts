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

import {
    MAX_RUNTIME_SYSTEM_HINTS,
} from "./constants.js"
import {
    isShellExecutionAnomalyFailure,
    isWatchModeOutput,
} from "./recovery-detectors.js"
import { inferAdvancedRecoveryHint } from "./recovery-hints-advanced.js"
import type { ToolCallRecord } from "./tool-result.js"
import {
    didToolCallFail,
    extractToolFailureText,
} from "./tool-result.js"

// Re-export from tool-result for backwards compatibility
export { buildSemanticToolCallKey, didToolCallFail, extractToolFailureText, parseToolResultObject } from "./tool-result.js"
export type { ToolCallRecord } from "./tool-result.js"

// Re-export from quality-proxy for backwards compatibility
export { computeQualityProxy } from "./quality-proxy.js"
export type { QualityProxyInput } from "./quality-proxy.js"

// ============================================================================
// Types
// ============================================================================

export interface RecoveryHint {
  /** Dedup key — same key never emitted twice in one run. */
  key: string
  /** Human-readable advice injected as a system message. */
  message: string
}

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
  return hints.slice(0, MAX_RUNTIME_SYSTEM_HINTS)
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
  const failureText = extractToolFailureText(call)

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

  // ── Advanced patterns — delegated to recovery-hints-advanced ──
  return inferAdvancedRecoveryHint(call)
}

/**
 * Recovery hint system (inspired by agenc-core's 50+ pattern matchers).
 *
 * After each tool call round, checks for known failure patterns and injects
 * targeted recovery hints so the LLM tries the RIGHT fix instead of blindly
 * retrying. Each hint is emitted at most once per run (tracked via emittedKeys).
 *
 * @module
 */

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
}

/**
 * Scan a round of tool calls for known failure patterns.
 * Returns recovery hints that haven't been emitted yet.
 */
export function buildRecoveryHints(
  roundCalls: readonly ToolCallRecord[],
  emittedHints: Set<string>,
): RecoveryHint[] {
  const hints: RecoveryHint[] = []

  for (const call of roundCalls) {
    const hint = inferRecoveryHint(call)
    if (!hint) continue
    if (emittedHints.has(hint.key)) continue
    emittedHints.add(hint.key)
    hints.push(hint)
  }

  // Max 4 hints per round to avoid flooding context
  return hints.slice(0, 4)
}

function inferRecoveryHint(call: ToolCallRecord): RecoveryHint | undefined {
  // Only check failures for most patterns
  const result = call.result
  const resultLower = result.toLowerCase()

  // ── Success-path hints (correct even non-errors) ──────────────

  // Watch mode detection on successful but hanging test commands
  if (!call.isError && call.name === "run_command") {
    if (isWatchModeOutput(resultLower)) {
      return {
        key: "test-runner-watch-mode",
        message:
          "This test command entered interactive watch mode and may have timed out. " +
          "Retry with a non-interactive single-run invocation. " +
          "For Vitest: `vitest run` or `vitest --run`. " +
          "For Jest: `CI=1 npm test` or `jest --runInBand`. " +
          "For pytest: remove `-s` interactive flags.",
      }
    }
  }

  // ── Failure-path hints ────────────────────────────────────────

  if (!call.isError && !resultLower.includes("error")) return undefined

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

  // Compilation errors (C/C++/Rust/Go)
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

  return undefined
}

/** Check if output looks like a test runner in watch mode. */
function isWatchModeOutput(text: string): boolean {
  return /watch.*usage|press.*to|watching for/i.test(text)
    && /tests?\s+\d|suite/i.test(text)
}

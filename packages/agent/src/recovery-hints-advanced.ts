/**
 * Advanced recovery hint inference — pattern-specific hints for
 * build tools, test runners, compilers, package managers, shell
 * syntax, and delegation issues.
 *
 * Separated from recovery.ts to keep each file focused and under 500 LOC.
 */

import { SHELL_BUILTIN_COMMANDS } from "./constants.js"
import {
    commandBasename,
    extractCompilerDiagnosticLocation,
    extractCompilerSuggestedName,
    extractDuplicateExportName,
    extractMissingNpmScriptName,
    extractSpawnEnoentCommand,
    extractUnknownTypeNameFromCompilerFailure,
    hasBrokenHeredocConjunctionShape,
    isCompilerDiagnosticFailure,
    isCompilerInterfaceDriftFailure,
    isDuplicateExportFailure,
    isHeaderTypeOrderingCompilerFailure,
    isJsonEscapedSourceLiteralFailure,
    isLikelyGrepOperandShapeFailure,
    isLikelyLiteralGlobFailure,
    isMissingLocalPackageDistFailure,
    isMissingNpmScriptFailure,
    isMissingNpmWorkspaceFailure,
    isPackagePathNotExportedFailure,
    isRecursiveNpmInstallLifecycleFailure,
    isTimedOutNonWatchTestRunnerFailure,
    isTypescriptRootDirScopeFailure,
    isUnsupportedWorkspaceProtocolFailure,
    isVitestUnsupportedThreadsFlagFailure,
    isWatchModeTestRunnerFailure,
} from "./recovery-detectors.js"
import type { ToolCallRecord } from "./tool-result.js"
import { extractToolFailureText, parseToolResultObject } from "./tool-result.js"

export interface RecoveryHint {
  key: string
  message: string
}

/**
 * Infer an advanced recovery hint from a tool call result.
 * Covers: test runners, compilers, package managers, shell syntax,
 * heredoc issues, grep/glob patterns, delegation, and browser checks.
 *
 * Called after common hints have been checked.
 */
export function inferAdvancedRecoveryHint(call: ToolCallRecord): RecoveryHint | undefined {
  const result = call.result
  const resultLower = result.toLowerCase()
  const parsedResult = parseToolResultObject(result)
  const failureText = extractToolFailureText(call)
  const failureTextLower = failureText.toLowerCase()

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

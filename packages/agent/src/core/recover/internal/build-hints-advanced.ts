/**
 * Advanced recovery hint inference — pattern-specific hints for
 * compilers, shell syntax, delegation, and browser checks.
 *
 * Test-runner / npm / TypeScript-rootDir patterns live in
 * recovery/advanced-build.ts.
 *
 * @module
 */

import { SHELL_BUILTIN_COMMANDS } from "../../../domain/types/agent-constants.js"
import type { ToolCallRecord } from "../../../tools/_shared/result.js"
import { extractToolFailureText, parseToolResultObject } from "../../../tools/_shared/result.js"
import { tryNpmHint, tryTestRunnerHint, type AdvancedHintContext } from "./build-advanced.js"
import {
  commandBasename,
  extractCompilerDiagnosticLocation,
  extractCompilerSuggestedName,
  extractDuplicateExportName,
  extractSpawnEnoentCommand,
  extractUnknownTypeNameFromCompilerFailure,
  hasBrokenHeredocConjunctionShape,
  isCompilerDiagnosticFailure,
  isCompilerInterfaceDriftFailure,
  isDuplicateExportFailure,
  isHeaderTypeOrderingCompilerFailure,
  isJsonEscapedSourceLiteralFailure,
  isLikelyGrepOperandShapeFailure,
  isLikelyLiteralGlobFailure
} from "./recovery-detectors.js"

export interface RecoveryHint {
  key: string
  message: string
}

/**
 * Infer an advanced recovery hint from a tool call result.
 * Covers: test runners, compilers, package managers, shell syntax,
 * heredoc issues, grep/glob patterns, and browser checks.
 *
 * Called after common hints have been checked.
 */
export function inferAdvancedRecoveryHint(call: ToolCallRecord): RecoveryHint | undefined {
  const result = call.result
  const parsedResult = parseToolResultObject(result)
  const failureText = extractToolFailureText(call)
  const failureTextLower = failureText.toLowerCase()
  const ctx: AdvancedHintContext = { call, parsedResult, failureText, failureTextLower }

  return (
    tryTestRunnerHint(ctx) ??
    tryNpmHint(ctx) ??
    tryDuplicateExportHint(failureText) ??
    tryJsonEscapedLiteralHint(failureText) ??
    tryCompilerDiagnosticHint(call, failureText) ??
    tryShellSyntaxHint(call, failureTextLower) ??
    tryShellBuiltinHint(failureText)
  )
}

function tryDuplicateExportHint(failureText: string): RecoveryHint | undefined {
  if (!isDuplicateExportFailure(failureText)) return undefined
  const exportName = extractDuplicateExportName(failureText) ?? "the symbol"
  return {
    key: `duplicate-export:${exportName.toLowerCase()}`,
    message:
      `Module exports \`${exportName}\` more than once. ` +
      "If the declaration already has an export modifier, remove the extra re-export. " +
      "After editing, rerun the build/test command."
  }
}

function tryJsonEscapedLiteralHint(failureText: string): RecoveryHint | undefined {
  if (!isJsonEscapedSourceLiteralFailure(failureText)) return undefined
  return {
    key: "json-escaped-source-literal",
    message:
      'JSON escape sequences like `\\\\"` or `\\\\n` were written into source code. ' +
      "Re-read the failing source file, replace the escaped text with raw source code, " +
      "and pass file contents directly instead of JSON-encoded representations."
  }
}

function tryCompilerDiagnosticHint(call: ToolCallRecord, failureText: string): RecoveryHint | undefined {
  if (!isCompilerDiagnosticFailure(call, failureText)) return undefined
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
        "and only rerun the build after the full interface is consistent."
    }
  }
  if (isHeaderTypeOrderingCompilerFailure(failureText)) {
    return {
      key: location ? `compiler-header-ordering:${location.toLowerCase()}` : "compiler-header-ordering",
      message:
        "The compiler is reporting a header/type-ordering error" +
        (location ? ` at \`${location}\`` : "") +
        (unknownTypeName ? ` involving \`${unknownTypeName}\`` : "") +
        ". Move the type definition or forward declaration before the first use, then rebuild."
    }
  }
  return {
    key: location ? `compiler-diagnostic:${location.toLowerCase()}` : "compiler-diagnostic",
    message:
      "The compiler identified a concrete source location" +
      (location ? ` (\`${location}\`)` : "") +
      ". Stop rerunning the same build command. Read and edit the cited file, fix the error, " +
      "and only rerun the build after the source change is in place."
  }
}

function tryShellSyntaxHint(call: ToolCallRecord, failureTextLower: string): RecoveryHint | undefined {
  if (hasBrokenHeredocConjunctionShape(call.args, failureTextLower)) {
    return {
      key: "heredoc-conjunction-shape",
      message:
        "This shell script put `&&`, `||`, or `;` on a new line after a heredoc terminator, " +
        "which is invalid shell syntax. Split the follow-up command into a separate tool call, " +
        "or use write_file for file contents instead of shell heredocs."
    }
  }

  if (isLikelyGrepOperandShapeFailure(call, failureTextLower)) {
    return {
      key: "grep-shape",
      message:
        "For code search, prefer `grep -r pattern path` or `rg pattern path`. " +
        "When using alternation like `foo|bar`, add `-E` flag. " +
        "Without file paths, grep reads stdin — pair `--include` with `-r` and a directory."
    }
  }

  if (isLikelyLiteralGlobFailure(call, failureTextLower)) {
    return {
      key: "literal-glob-operand",
      message:
        "Shell globs like `*.ts` may not expand in direct mode. " +
        "Enumerate matches with `find` or `rg --files` first, or pass the full command as a shell string."
    }
  }
  return undefined
}

function tryShellBuiltinHint(failureText: string): RecoveryHint | undefined {
  const spawnEnoentCommand = extractSpawnEnoentCommand(failureText)
  if (!spawnEnoentCommand) return undefined
  const missingCommand = commandBasename(spawnEnoentCommand)
  if (SHELL_BUILTIN_COMMANDS.has(missingCommand)) {
    return {
      key: "shell-builtin",
      message:
        `Shell builtins like \`${missingCommand}\` are not standalone executables. ` +
        "Run the full shell command as a single string."
    }
  }
  return {
    key: `missing-command:${missingCommand}`,
    message:
      `Executable \`${missingCommand}\` was not found on PATH. ` +
      "If it's a project-local tool, try `npx ${missingCommand}` or `npm exec -- ${missingCommand}`. " +
      "Otherwise install it first."
  }
}

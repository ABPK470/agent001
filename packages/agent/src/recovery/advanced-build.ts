/**
 * Advanced recovery hints for test runners, package managers, and TypeScript.
 *
 * Each helper returns `undefined` when the pattern doesn't match so the
 * caller can chain them with `??`.
 *
 * @module
 */

import {
    extractMissingNpmScriptName,
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
} from "../recovery-detectors.js"
import type { RecoveryHint } from "../recovery.js"
import type { ToolCallRecord } from "../tool-result.js"
import { parseToolResultObject } from "../tool-result.js"

export interface AdvancedHintContext {
  readonly call: ToolCallRecord
  readonly parsedResult: ReturnType<typeof parseToolResultObject>
  readonly failureText: string
  readonly failureTextLower: string
}

export function tryTestRunnerHint(ctx: AdvancedHintContext): RecoveryHint | undefined {
  const { call, parsedResult, failureTextLower } = ctx
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

  if (isVitestUnsupportedThreadsFlagFailure(call, failureTextLower)) {
    return {
      key: "vitest-unsupported-threads-flag",
      message:
        "Vitest rejected an unsupported thread flag. Do not invent `--threads` or `--no-threads`. " +
        "Keep the command in single-run mode (`vitest run` or `vitest --run`). " +
        "If worker strategy matters, use `--pool=<threads|forks>` or project config instead.",
    }
  }
  return undefined
}

export function tryNpmHint(ctx: AdvancedHintContext): RecoveryHint | undefined {
  const { call, parsedResult, failureText, failureTextLower } = ctx

  if (isUnsupportedWorkspaceProtocolFailure(failureTextLower)) {
    return {
      key: "workspace-protocol-unsupported",
      message:
        "This package manager rejected `workspace:*`. Do not assume workspace protocol support. " +
        "Rewrite the local dependency to a host-compatible specifier, then rerun `npm install`.",
    }
  }

  if (isRecursiveNpmInstallLifecycleFailure(call, parsedResult)) {
    return {
      key: "recursive-npm-install-lifecycle",
      message:
        "This project defines an `install` lifecycle that recursively reruns `npm install`, causing a loop. " +
        "Remove or rename the recursive `install` script in `package.json`, then rerun `npm install`.",
    }
  }

  if (isMissingNpmScriptFailure(call, failureText)) {
    const scriptName = extractMissingNpmScriptName(failureText) ?? "requested"
    return {
      key: `missing-npm-script:${scriptName.toLowerCase()}`,
      message:
        `The current package.json does not define npm script \`${scriptName}\`. ` +
        "Inspect package.json, add the missing script, or run the correct command directly.",
    }
  }

  if (isMissingNpmWorkspaceFailure(call, failureText)) {
    return {
      key: "missing-npm-workspace",
      message:
        "npm could not match the `--workspace` selector. " +
        "Inspect root `package.json` workspaces and each package `name`, then rerun with exact workspace names " +
        "or run the command from the matching workspace cwd.",
    }
  }

  if (isMissingLocalPackageDistFailure(failureText)) {
    return {
      key: "local-package-dist-missing",
      message:
        "This local package link resolved to a `dist/*` entry that doesn't exist yet. " +
        "Build the dependency package first, then rerun the command.",
    }
  }

  if (isPackagePathNotExportedFailure(failureTextLower)) {
    return {
      key: "package-exports-mismatch",
      message:
        "This package's `exports` map does not match how the command is loading it. " +
        "Inspect `package.json` `exports`/`main`/`types`, then retry with an entry point that matches the package format.",
    }
  }

  if (isTypescriptRootDirScopeFailure(failureText)) {
    return {
      key: "typescript-rootdir-scope",
      message:
        "This TypeScript config includes files outside `rootDir`. " +
        "Either remove the restrictive `rootDir`, exclude config files from tsconfig, " +
        "or move Node-side config files into a separate `tsconfig.node.json`.",
    }
  }

  return undefined
}

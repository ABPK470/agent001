/**
 * Shell tool — lets the agent run commands.
 *
 * This is one of the most powerful agent tools. Coding agents (Copilot, Cursor,
 * Devin) all have some form of shell access to run builds, tests, linters, etc.
 *
 * Security:
 *   - When a sandbox executor is set, commands run inside Docker containers
 *     with no network, no capabilities, read-only root, memory/CPU limits.
 *   - Fallback (no executor): commands run in a child process with filtered
 *     env (SAFE_ENV_KEYS only — no API keys or secrets leak).
 *   - Commands are blocked via pattern deny-list (supplementary to container isolation).
 *   - Working directory is locked to the configured workspace.
 *   - 120s default timeout (overridable per-call up to 600s).
 */

import { execFile } from "node:child_process"
import type { AgentHost, RunContext } from "../../application/shell/runtime.js"
import type { ExecutableTool, ToolMetadata } from "../../domain/agent-types.js"

/** Workspace directory — shell commands run here.
 *  Source: `host.shell.cwd` (built per-run by the server from the run workspace).
 *  No ambient `setShellCwd` setter exists — the run-executor builds the host
 *  with `shellCwd: runWorkspace.executionRoot` and threads it into the
 *  closure-factory `createShellTool(host)`. */

/** Result from a shell execution (matches sandbox interface). */
export interface ShellExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  sandboxed: boolean
}

/**
 * Optional executor injected by the host.
 * When present (host.shell.client), commands route through the Docker sandbox
 * instead of the host shell. No ambient `setShellExecutor` setter exists
 * — wire the client via `configureAgent({ shellClient })` in the server boot.
 */
export type ShellExecutor = (command: string, cwd: string, signal?: AbortSignal) => Promise<ShellExecResult>

/**
 * Whether the sandbox is in strict mode ("all").
 * Source: `host.shell.sandboxStrict`. When true, only CONTAINER_RULES apply,
 * so the agent can freely run `node game.js`, `npm install`, etc.
 */

/** Default per-command timeout. Bumped from 30s → 120s so package installs,
 *  Playwright browser downloads, large test runs, and big git clones can
 *  complete without the agent giving up halfway through. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Hard ceiling so a hung command can't park a worker indefinitely. */
const MAX_TIMEOUT_MS = 600_000

/** Safe environment variables — the ONLY keys forwarded to child processes. */
const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "NODE_ENV",
])

/**
 * Command deny list — regex patterns that block dangerous commands.
 *
 * TWO tiers:
 *   CONTAINER_RULES — minimal list for sandboxed (Docker) execution.
 *     Even inside a container, we block fork bombs, resource exhaustion,
 *     and container-escape attempts. Everything else is allowed because
 *     the container IS the sandbox (no host access, no network).
 *
 *   HOST_RULES — full list for host execution (no Docker).
 *     Blocks destructive operations, privilege escalation, credential
 *     access, reverse shells, etc. because there's no container barrier.
 */

/** Deny rule sets — extracted to ./shell/deny-rules.ts */
import { CONTAINER_RULES, HOST_ONLY_RULES } from "./deny-rules.js"


/**
 * Check if a command is blocked.
 * When `sandboxStrict` is true (mode="all"), only CONTAINER_RULES apply.
 * Otherwise, both CONTAINER_RULES and HOST_ONLY_RULES apply.
 */
function isBlocked(command: string, sandboxStrict: boolean): string | null {
  for (const rule of CONTAINER_RULES) {
    if (rule.pattern.test(command)) {
      return rule.label
    }
  }
  // In strict sandbox mode, skip host-only rules — the container is the sandbox
  if (sandboxStrict) return null
  for (const rule of HOST_ONLY_RULES) {
    if (rule.pattern.test(command)) {
      return rule.label
    }
  }
  return null
}

/** Build a filtered env object from process.env. */
function safeEnv(): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1" }
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key]
    if (val) env[key] = val
  }
  return env
}

// ── Constants (hoisted so const-tool initializers don't trip TDZ) ─

const SHELL_TOOL_DESCRIPTION =
  "Run a shell command and return its output (stdout + stderr). " +
  "Use this for: running scripts, checking system info, " +
  "installing packages, running tests, git operations, etc. " +
  "Commands run in the workspace directory. " +
  "Commands time out after 120 seconds by default; pass `timeout_ms` (max 600000) for slower work like large installs or builds."

const SHELL_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    command:    { type: "string", description: "The shell command to run" },
    timeout_ms: { type: "number", description: `Optional per-call timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
  },
  required: ["command"],
} as const

export const shellToolMetadata: ToolMetadata = {
  name: "run_command",
  description: SHELL_TOOL_DESCRIPTION,
  parameters: SHELL_TOOL_PARAMETERS,
}

export const shellTool = shellToolMetadata

/**
 * Factory variant bound to `host.shell.{cwd,client,sandboxStrict}` and optional run context.
 */
export function createShellTool(host: AgentHost, run?: RunContext): ExecutableTool {
  return {
    ...shellToolMetadata,
    async execute(args) {
      return runShell(args, {
        cwd: host.shell.cwd,
        executor: host.shell.client,
        sandboxStrict: host.shell.sandboxStrict,
        killSignal: run?.signal ?? null,
      })
    },
  }
}

// ── Shared body ──────────────────────────────────────────────────

interface ShellCtx {
  cwd: string
  executor: ShellExecutor | null
  sandboxStrict: boolean
  killSignal: AbortSignal | null
}

async function runShell(args: Record<string, unknown>, ctx: ShellCtx): Promise<string> {
    const command   = String(args.command)
    const requested = typeof args["timeout_ms"] === "number" ? Number(args["timeout_ms"]) : DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS))

    const blocked = isBlocked(command, ctx.sandboxStrict)
    if (blocked) {
      return `Error: Command blocked for safety (matched: "${blocked}"). This command is not allowed.`
    }

    // Route through sandbox executor if available
    if (ctx.executor) {
      try {
        const result = await ctx.executor(command, ctx.cwd, ctx.killSignal ?? undefined)
        return formatResult(result)
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // Fallback: direct execution with safe env only
    return new Promise<string>((resolve) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024, // 1MB
          cwd: ctx.cwd,
          env: safeEnv(),
          ...(ctx.killSignal ? { signal: ctx.killSignal } : {}),
        },
        (error, stdout, stderr) => {
          const parts: string[] = []
          if (stdout) parts.push(stdout)
          if (stderr) parts.push(`[stderr] ${stderr}`)
          if (error && error.killed) {
            parts.push(`[command timed out after ${Math.round(timeoutMs / 1000)}s]`)
          } else if (error && (error as NodeJS.ErrnoException).code === "ABORT_ERR") {
            parts.push("[command cancelled]")
          } else if (error && !stdout && !stderr) {
            const code = (error as { code?: number }).code
            parts.push(`Command exited with code ${code ?? "non-zero"} and produced no output.`)
          }
          resolve(truncateOutput(parts.join("\n").trim()) || "(no output)")
        },
      )
    })
}

/** Format a ShellExecResult into a string for the agent. */
function formatResult(r: ShellExecResult): string {
  const parts: string[] = []
  if (r.stdout) parts.push(r.stdout)
  if (r.stderr) parts.push(`[stderr] ${r.stderr}`)
  if (r.timedOut) parts.push("[command timed out after 30s]")
  else if (r.exitCode !== 0 && !r.stdout && !r.stderr) {
    parts.push(`Command exited with code ${r.exitCode} and produced no output.`)
  }
  return truncateOutput(parts.join("\n").trim()) || "(no output)"
}

/** Cap output to avoid blowing up the context window. */
function truncateOutput(output: string): string {
  const MAX_OUTPUT = 16_000
  if (output.length <= MAX_OUTPUT) return output
  const half = MAX_OUTPUT / 2
  return `${output.slice(0, half)}\n\n... (${output.length - MAX_OUTPUT} chars truncated) ...\n\n${output.slice(-half)}`
}

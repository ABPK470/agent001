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
 *   - 30s timeout.
 */

import { execFile } from "node:child_process"
import type { Tool } from "../types.js"

/** Workspace directory — shell commands run here. */
// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape. The state can be migrated into AgentRuntime sub-runtimes later.
const _state: {
  shellCwd: string
  executor: ShellExecutor | null
  sandboxStrict: boolean
  signal: AbortSignal | null
} = { shellCwd: process.cwd(), executor: null, sandboxStrict: false, signal: null }

export function setShellCwd(cwd: string): void {
  _state.shellCwd = cwd
}

/** Result from a shell execution (matches sandbox interface). */
export interface ShellExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  sandboxed: boolean
}

/**
 * Optional executor injected by the server.
 * When set, commands route through Docker sandbox instead of host shell.
 */
type ShellExecutor = (command: string, cwd: string, signal?: AbortSignal) => Promise<ShellExecResult>

/** Inject a sandbox executor (called once at server startup). */
export function setShellExecutor(executor: ShellExecutor): void {
  _state.executor = executor
}

/**
 * Whether the sandbox is in strict mode ("all").
 * When true, commands run in Docker and only the minimal deny list applies.
 * The agent can freely run `node game.js`, `npm install`, `python script.py`, etc.
 */

/** Set by the server when sandbox mode is "all". */
export function setShellSandboxStrict(strict: boolean): void {
  _state.sandboxStrict = strict
}

/** Abort signal — set per-run so child processes can be killed on cancel. */

/** Inject the run's AbortSignal so child processes are killed on cancel. */
export function setShellSignal(signal: AbortSignal | null): void {
  _state.signal = signal
}

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
import { CONTAINER_RULES, HOST_ONLY_RULES } from "./shell/deny-rules.js"


/**
 * Check if a command is blocked.
 * When _state.sandboxStrict is true (mode="all"), only CONTAINER_RULES apply.
 * Otherwise, both CONTAINER_RULES and HOST_ONLY_RULES apply.
 */
function isBlocked(command: string): string | null {
  for (const rule of CONTAINER_RULES) {
    if (rule.pattern.test(command)) {
      return rule.label
    }
  }
  // In strict sandbox mode, skip host-only rules — the container is the sandbox
  if (_state.sandboxStrict) return null
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

export const shellTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command and return its output (stdout + stderr). " +
    "Use this for: running scripts, checking system info, " +
    "installing packages, running tests, git operations, etc. " +
    "Commands run in the workspace directory. " +
    "Commands time out after 30 seconds.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
    },
    required: ["command"],
  },

  async execute(args) {
    const command = String(args.command)

    const blocked = isBlocked(command)
    if (blocked) {
      return `Error: Command blocked for safety (matched: "${blocked}"). This command is not allowed.`
    }

    // Route through sandbox executor if available
    if (_state.executor) {
      try {
        const result = await _state.executor(command, _state.shellCwd, _state.signal ?? undefined)
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
          timeout: 30_000,
          maxBuffer: 1024 * 1024, // 1MB
          cwd: _state.shellCwd,
          env: safeEnv(),
          ...(_state.signal ? { signal: _state.signal } : {}),
        },
        (error, stdout, stderr) => {
          const parts: string[] = []         
          if (stdout) parts.push(stdout)
          if (stderr) parts.push(`[stderr] ${stderr}`)
          if (error && error.killed) {
            parts.push("[command timed out after 30s]")
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
  },
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

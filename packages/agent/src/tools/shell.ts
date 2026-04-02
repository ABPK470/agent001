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
let _shellCwd = process.cwd()

export function setShellCwd(cwd: string): void {
  _shellCwd = cwd
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
type ShellExecutor = (command: string, cwd: string) => Promise<ShellExecResult>
let _executor: ShellExecutor | null = null

/** Inject a sandbox executor (called once at server startup). */
export function setShellExecutor(executor: ShellExecutor): void {
  _executor = executor
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

/** Commands (or substrings) that are always blocked. */
const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  "> /dev/sd",
  "chmod -R 777 /",
  ":(){ :|:& };:",    // fork bomb
  "shutdown",
  "reboot",
  "halt",
  "init 0",
  "init 6",
  "systemctl poweroff",
  "systemctl reboot",
  "/etc/shadow",
  "/etc/passwd",
  "launchctl",
  "crontab",
  "curl|sh",
  "curl|bash",
  "wget|sh",
  "wget|bash",
  "eval(",
  "base64 -d",
  "nc -l",
  "ncat -l",
  "socat",
]

function isBlocked(command: string): string | null {
  const lower = command.toLowerCase().replace(/\s+/g, "")
  for (const pattern of BLOCKED_PATTERNS) {
    if (lower.includes(pattern.toLowerCase().replace(/\s+/g, ""))) {
      return pattern
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
    if (_executor) {
      try {
        const result = await _executor(command, _shellCwd)
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
          cwd: _shellCwd,
          env: safeEnv(),
        },
        (error, stdout, stderr) => {
          const parts: string[] = []         
          if (stdout) parts.push(stdout)
          if (stderr) parts.push(`[stderr] ${stderr}`)
          if (error && error.killed) {
            parts.push("[command timed out after 30s]")
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

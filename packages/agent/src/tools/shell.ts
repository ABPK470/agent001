/**
 * Shell tool — lets the agent run commands.
 *
 * This is one of the most powerful agent tools. Coding agents (Copilot, Cursor,
 * Devin) all have some form of shell access to run builds, tests, linters, etc.
 *
 * Security:
 *   - Commands run in a child process with a timeout (30s)
 *   - Working directory is locked to the configured workspace
 *   - Dangerous commands are blocked via blocklist
 */

import { execFile } from "node:child_process"
import type { Tool } from "../types.js"

/** Workspace directory — shell commands run here. */
let _shellCwd = process.cwd()

export function setShellCwd(cwd: string): void {
  _shellCwd = cwd
}

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
]

function isBlocked(command: string): string | null {
  const lower = command.toLowerCase()
  for (const pattern of BLOCKED_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return pattern
    }
  }
  return null
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

    return new Promise<string>((resolve) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        {
          timeout: 30_000,
          maxBuffer: 1024 * 1024, // 1MB
          cwd: _shellCwd,
          env: { ...process.env, NO_COLOR: "1" },
        },
        (error, stdout, stderr) => {
          const parts: string[] = []         
          if (stdout) parts.push(stdout)
          if (stderr) parts.push(`[stderr] ${stderr}`)
          if (error && error.killed) {
            parts.push("[command timed out after 30s]")
          } else if (error && !stdout && !stderr) {
            parts.push(`Error: ${error.message}`)
          }
          let output = parts.join("\n").trim()
          // Cap output to avoid blowing up the context window
          const MAX_OUTPUT = 16000
          if (output.length > MAX_OUTPUT) {
            const head = output.slice(0, MAX_OUTPUT / 2)
            const tail = output.slice(-MAX_OUTPUT / 2)
            output = `${head}\n\n... (${output.length - MAX_OUTPUT} chars truncated) ...\n\n${tail}`
          }
          resolve(output || "(no output)")
        },
      )
    })
  },
}

/**
 * Shell tool — lets the agent run commands.
 *
 * This is one of the most powerful agent tools. Coding agents (Copilot, Cursor,
 * Devin) all have some form of shell access to run builds, tests, linters, etc.
 *
 * Security: commands run in a child process with a timeout.
 * In production you'd add allowlists, sandboxing, or confirmation prompts.
 */

import { execFile } from "node:child_process"
import type { Tool } from "../types.js"

export const shellTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command and return its output (stdout + stderr). " +
    "Use this for: running scripts, checking system info, " +
    "installing packages, running tests, git operations, etc. " +
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

    return new Promise<string>((resolve) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        {
          timeout: 30_000,
          maxBuffer: 1024 * 1024, // 1MB
          cwd: process.cwd(),
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
          const output = parts.join("\n").trim()
          resolve(output || "(no output)")
        },
      )
    })
  },
}

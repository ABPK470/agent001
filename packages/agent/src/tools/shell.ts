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

/**
 * Whether the sandbox is in strict mode ("all").
 * When true, commands run in Docker and only the minimal deny list applies.
 * The agent can freely run `node game.js`, `npm install`, `python script.py`, etc.
 */
let _sandboxStrict = false

/** Set by the server when sandbox mode is "all". */
export function setShellSandboxStrict(strict: boolean): void {
  _sandboxStrict = strict
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

/** Rules that apply even INSIDE a Docker container. */
const CONTAINER_RULES: Array<{ pattern: RegExp; label: string }> = [
  // Fork bombs / resource exhaustion
  { pattern: /:\(\)\s*\{.*\}.*:\s*;/,                  label: "fork bomb" },
  { pattern: /\bfork\s*bomb/i,                         label: "fork bomb" },

  // Container / VM escape attempts
  { pattern: /\bdocker\s+run\b/i,                      label: "docker run" },
  { pattern: /\bdocker\s+exec\b/i,                     label: "docker exec" },
  { pattern: /\bdocker\s+cp\b/i,                       label: "docker cp" },
  { pattern: /--privileged/i,                           label: "--privileged" },
  { pattern: /--pid=host/i,                             label: "--pid=host" },
  { pattern: /--net=host/i,                             label: "--net=host" },
  { pattern: /\bnsenter\b/i,                           label: "nsenter" },
  { pattern: /\bchroot\b/i,                            label: "chroot" },
  { pattern: /\bunshare\b/i,                           label: "unshare" },
  { pattern: /\bkubectl\s+exec/i,                      label: "kubectl exec" },

  // Kernel module manipulation (even w/ dropped caps, block by name)
  { pattern: /\bmodprobe\b/i,                          label: "modprobe" },
  { pattern: /\binsmod\b/i,                            label: "insmod" },
  { pattern: /\brmmod\b/i,                             label: "rmmod" },
]

/** Additional rules that apply ONLY on host (no Docker). */
const HOST_ONLY_RULES: Array<{ pattern: RegExp; label: string }> = [
  // ── Destructive filesystem ──────────────────────────────────────
  { pattern: /rm\s+-[a-z]*r[a-z]*f?\s+\/(?!\w)/i,   label: "rm -rf /" },
  { pattern: /rm\s+-[a-z]*f[a-z]*r?\s+\/(?!\w)/i,    label: "rm -rf /" },
  { pattern: /rm\s+--no-preserve-root/i,               label: "rm --no-preserve-root" },
  { pattern: /\bshred\b/i,                             label: "shred" },
  { pattern: /\bmkfs\b/i,                              label: "mkfs" },
  { pattern: /\bdd\s+if=/i,                            label: "dd if=" },
  { pattern: />\s*\/dev\/sd/i,                          label: "> /dev/sd" },
  { pattern: />\s*\/dev\/nvme/i,                        label: "> /dev/nvme" },
  { pattern: /\bfdisk\b/i,                             label: "fdisk" },
  { pattern: /\bparted\b/i,                            label: "parted" },
  { pattern: /\bformat\s+[a-z]:/i,                     label: "format drive" },
  { pattern: /chmod\s+-R\s+777\s+\//i,                 label: "chmod -R 777 /" },
  { pattern: /chown\s+-R\s+.*\s+\//i,                  label: "chown -R /" },

  // ── Infinite loops ──────────────────────────────────────────
  { pattern: /while\s*true.*do.*done/i,                label: "infinite loop" },

  // ── System administration / shutdown ────────────────────────
  { pattern: /\bshutdown\b/i,                          label: "shutdown" },
  { pattern: /\breboot\b/i,                            label: "reboot" },
  { pattern: /\bhalt\b/i,                              label: "halt" },
  { pattern: /\binit\s+[06]\b/,                        label: "init 0/6" },
  { pattern: /\bsystemctl\s+(poweroff|reboot|halt)/i,  label: "systemctl poweroff/reboot" },
  { pattern: /\btelinit\s+[06]\b/,                     label: "telinit 0/6" },
  { pattern: /\blaunchctl\b/i,                         label: "launchctl" },
  { pattern: /\bsysctl\s+-w\b/i,                       label: "sysctl -w" },
  { pattern: /\bkernelctl\b/i,                         label: "kernelctl" },

  // ── Cron / scheduled tasks ──────────────────────────────────
  { pattern: /\bcrontab\b/i,                           label: "crontab" },
  { pattern: /\bat\b\s+-f/i,                           label: "at -f" },
  { pattern: /\/etc\/cron/i,                            label: "/etc/cron" },

  // ── Privilege escalation ────────────────────────────────────
  { pattern: /\bsudo\b/i,                              label: "sudo" },
  { pattern: /\bsu\s+-?\s*$/im,                        label: "su" },
  { pattern: /\bsu\s+root/i,                           label: "su root" },
  { pattern: /\bdoas\b/i,                              label: "doas" },
  { pattern: /\bchmod\s+[u+]*s\b/i,                   label: "chmod setuid" },
  { pattern: /\bsetcap\b/i,                            label: "setcap" },
  { pattern: /\bpasswd\b/i,                            label: "passwd" },
  { pattern: /\busermod\b/i,                           label: "usermod" },
  { pattern: /\buseradd\b/i,                           label: "useradd" },
  { pattern: /\buserdel\b/i,                           label: "userdel" },
  { pattern: /\bgroupadd\b/i,                          label: "groupadd" },
  { pattern: /\bvisudo\b/i,                            label: "visudo" },

  // ── Credential / sensitive file access ──────────────────────
  { pattern: /\/etc\/shadow/i,                          label: "/etc/shadow" },
  { pattern: /\/etc\/passwd/i,                          label: "/etc/passwd" },
  { pattern: /\/etc\/sudoers/i,                         label: "/etc/sudoers" },
  { pattern: /\/etc\/ssh/i,                             label: "/etc/ssh" },
  { pattern: /~\/\.ssh/,                                label: "~/.ssh" },
  { pattern: /\.ssh\/id_/i,                             label: ".ssh/id_*" },
  { pattern: /\.aws\/credentials/i,                     label: ".aws/credentials" },
  { pattern: /\.env\b(?!iron)/i,                        label: ".env file" },
  { pattern: /\.gnupg/i,                                label: ".gnupg" },
  { pattern: /\.kube\/config/i,                         label: ".kube/config" },
  { pattern: /\.docker\/config\.json/i,                 label: ".docker/config.json" },
  { pattern: /\bprintenv\b/i,                          label: "printenv" },
  { pattern: /\/proc\/self/i,                           label: "/proc/self" },
  { pattern: /\/proc\/[0-9]+/i,                         label: "/proc/pid" },
  { pattern: /\bkeychain\b/i,                          label: "keychain" },
  { pattern: /\bsecurity\s+find-generic-password/i,    label: "macOS keychain read" },

  // ── Reverse shells / network listeners ──────────────────────
  { pattern: /\bnc\s+.*-[a-z]*l/i,                    label: "nc -l (listen)" },
  { pattern: /\bncat\s+.*-[a-z]*l/i,                  label: "ncat -l (listen)" },
  { pattern: /\bsocat\b/i,                             label: "socat" },
  { pattern: /\bnetcat\b/i,                            label: "netcat" },
  { pattern: /\/dev\/tcp\//i,                           label: "/dev/tcp" },
  { pattern: /\/dev\/udp\//i,                           label: "/dev/udp" },
  { pattern: /\bmkfifo\b.*\bnc\b/i,                   label: "mkfifo + nc (reverse shell)" },
  { pattern: /\btcpdump\b/i,                           label: "tcpdump" },
  { pattern: /\bwireshark\b/i,                         label: "wireshark" },
  { pattern: /\bnmap\b/i,                              label: "nmap" },
  { pattern: /\biptables\b/i,                          label: "iptables" },
  { pattern: /\bufw\b/i,                               label: "ufw" },

  // ── Code execution via pipe / eval ──────────────────────────
  { pattern: /curl\s.*\|\s*(?:ba)?sh/i,                label: "curl | sh" },
  { pattern: /wget\s.*\|\s*(?:ba)?sh/i,                label: "wget | sh" },
  { pattern: /curl\s.*\|\s*python/i,                   label: "curl | python" },
  { pattern: /wget\s.*\|\s*python/i,                   label: "wget | python" },
  { pattern: /\beval\s*\(/,                            label: "eval(" },
  { pattern: /\bexec\s*\(/,                            label: "exec(" },
  { pattern: /\bbase64\s+-d\b/i,                       label: "base64 -d" },
  { pattern: /\bbase64\s+--decode\b/i,                 label: "base64 --decode" },
  { pattern: /python[23]?\s+-c\s.*import\s+os/i,       label: "python -c import os" },
  { pattern: /perl\s+-e\s.*system/i,                   label: "perl -e system" },
  { pattern: /ruby\s+-e\s.*system/i,                   label: "ruby -e system" },

  // ── Package-manager abuse ───────────────────────────────────
  { pattern: /npm\s+.*--unsafe-perm/i,                 label: "npm --unsafe-perm" },
  { pattern: /pip\s+install\s+--pre/i,                 label: "pip install --pre" },

  // ── History / log exfiltration ──────────────────────────────
  { pattern: /\.bash_history/i,                         label: ".bash_history" },
  { pattern: /\.zsh_history/i,                          label: ".zsh_history" },
  { pattern: /\.histfile/i,                             label: ".histfile" },
  { pattern: /\/var\/log\//i,                           label: "/var/log/" },

  // ── Disk / mount operations ─────────────────────────────────
  { pattern: /\bmount\b.*\/dev\//i,                    label: "mount /dev/" },
  { pattern: /\bumount\b/i,                            label: "umount" },
  { pattern: /\blosetup\b/i,                           label: "losetup" },
]

/**
 * Check if a command is blocked.
 * When _sandboxStrict is true (mode="all"), only CONTAINER_RULES apply.
 * Otherwise, both CONTAINER_RULES and HOST_ONLY_RULES apply.
 */
function isBlocked(command: string): string | null {
  for (const rule of CONTAINER_RULES) {
    if (rule.pattern.test(command)) {
      return rule.label
    }
  }
  // In strict sandbox mode, skip host-only rules — the container is the sandbox
  if (_sandboxStrict) return null
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

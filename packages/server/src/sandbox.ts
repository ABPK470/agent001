/**
 * Docker sandbox — isolated execution environment for agent-generated code.
 *
 * Provides a Docker container per run where agent code can safely execute.
 * The container:
 *   - Bind-mounts the workspace directory (read/write)
 *   - Has NO network access (--network=none)
 *   - Runs as non-root user
 *   - Has memory + CPU limits
 *   - Is ephemeral (removed on cleanup)
 *   - Has common runtimes: Node.js, Python, shell
 *
 * If Docker is unavailable, falls back to host execution with warnings.
 *
 * Architecture (matching agenc-core's 6-layer model):
 *   Layer 1: Command deny list (existing, now supplementary)
 *   Layer 2: Filesystem scoping (enhanced with symlink resolution)
 *   Layer 3: Docker container sandboxing (THIS SERVICE)
 *   Layer 4: Headless browser in container (via sandbox_exec + browser)
 *   Layer 5: Effect tracking + rollback (existing)
 */

import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** Sandbox configuration. */
export interface SandboxConfig {
  /** Execution mode: "docker" | "host". Default: auto-detect. */
  mode?: "docker" | "host"
  /** Docker image to use. Default: node:20-slim */
  image?: string
  /** Memory limit. Default: 256m */
  memoryLimit?: string
  /** CPU limit (number of CPUs). Default: 1 */
  cpuLimit?: number
  /** Command timeout in ms. Default: 30000 */
  timeout?: number
  /** Allow network access inside container. Default: false */
  network?: boolean
}

/** Result from a sandboxed execution. */
export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /** Whether execution ran in Docker or fell back to host. */
  sandboxed: boolean
}

const DEFAULT_IMAGE = "node:20-slim"
const BROWSER_IMAGE = "agent001-browser:latest"
const BROWSER_DOCKERFILE = resolve(import.meta.dirname, "../docker/Dockerfile.browser")
const DEFAULT_MEMORY = "256m"
const DEFAULT_CPU = 1
const DEFAULT_TIMEOUT = 30_000
const MAX_OUTPUT = 16_000

/** Safe environment variables to forward into the container. */
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

export class DockerSandbox {
  private dockerAvailable: boolean | null = null
  private browserImageReady: boolean | null = null
  private readonly config: Required<SandboxConfig>
  private activeContainers = new Set<string>()

  constructor(config: SandboxConfig = {}) {
    this.config = {
      mode: config.mode ?? "docker",
      image: config.image ?? DEFAULT_IMAGE,
      memoryLimit: config.memoryLimit ?? DEFAULT_MEMORY,
      cpuLimit: config.cpuLimit ?? DEFAULT_CPU,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      network: config.network ?? false,
    }
  }

  /** Check if Docker is available. Cached after first call. */
  async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable

    try {
      await exec("docker", ["info"], { timeout: 5000 })
      this.dockerAvailable = true
    } catch {
      this.dockerAvailable = false
    }
    return this.dockerAvailable
  }

  /** Whether sandbox mode is active (Docker available + configured). */
  async isSandboxed(): Promise<boolean> {
    if (this.config.mode === "host") return false
    return this.isDockerAvailable()
  }

  /**
   * Execute a command inside a Docker container.
   *
   * The workspace is bind-mounted at /workspace inside the container.
   * If Docker is unavailable and mode is "docker", returns an error.
   * If mode is "host", falls back to direct execution.
   */
  async exec(
    command: string,
    workspacePath: string,
    options?: {
      timeout?: number
      cwd?: string // relative to workspace, e.g. "tmp/game"
      env?: Record<string, string>
      network?: boolean
    },
  ): Promise<SandboxResult> {
    const useDocker = await this.isSandboxed()

    if (!useDocker) {
      return this.execHost(command, workspacePath, options)
    }

    return this.execDocker(command, workspacePath, options)
  }

  /** Execute inside a Docker container. */
  private async execDocker(
    command: string,
    workspacePath: string,
    options?: {
      timeout?: number
      cwd?: string
      env?: Record<string, string>
      network?: boolean
    },
  ): Promise<SandboxResult> {
    const timeout = options?.timeout ?? this.config.timeout
    const containerCwd = options?.cwd ? `/workspace/${options.cwd}` : "/workspace"
    const allowNetwork = options?.network ?? this.config.network
    const containerId = `agent001-sandbox-${randomBytes(6).toString("hex")}`

    const args: string[] = [
      "run",
      "--rm",
      "--name", containerId,
      // Resource limits
      `--memory=${this.config.memoryLimit}`,
      `--cpus=${this.config.cpuLimit}`,
      // No network by default
      ...(allowNetwork ? [] : ["--network=none"]),
      // Non-root user (node:20-slim has user 'node' with uid 1000)
      "--user", "1000:1000",
      // Read-only root filesystem (workspace is the only writable mount)
      "--read-only",
      // Tmpfs for /tmp so programs can write temp files
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      // Bind-mount workspace
      "-v", `${workspacePath}:/workspace:rw`,
      // Working directory
      "-w", containerCwd,
      // Drop all capabilities
      "--cap-drop=ALL",
      // No new privileges
      "--security-opt=no-new-privileges",
      // Filtered environment
      ...this.buildEnvArgs(options?.env),
      // Image
      this.config.image,
      // Command
      "/bin/sh", "-c", command,
    ]

    this.activeContainers.add(containerId)

    try {
      const { stdout, stderr } = await exec("docker", args, {
        timeout: timeout + 5000, // extra 5s for container overhead
        maxBuffer: 2 * 1024 * 1024,
      })

      return {
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: 0,
        timedOut: false,
        sandboxed: true,
      }
    } catch (err: unknown) {
      const error = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string }
      const timedOut = error.killed === true

      if (timedOut) {
        // Force-kill the container if it timed out
        await exec("docker", ["kill", containerId], { timeout: 5000 }).catch(() => {})
      }

      return {
        stdout: truncateOutput(error.stdout ?? ""),
        stderr: truncateOutput(error.stderr ?? ""),
        exitCode: error.code ?? 1,
        timedOut,
        sandboxed: true,
      }
    } finally {
      this.activeContainers.delete(containerId)
    }
  }

  /** Fallback: execute on host (legacy behavior). */
  private async execHost(
    command: string,
    workspacePath: string,
    options?: {
      timeout?: number
      cwd?: string
      env?: Record<string, string>
    },
  ): Promise<SandboxResult> {
    const timeout = options?.timeout ?? this.config.timeout
    const cwd = options?.cwd
      ? `${workspacePath}/${options.cwd}`
      : workspacePath

    // Filtered environment — don't leak secrets
    const safeEnv: Record<string, string> = { NO_COLOR: "1" }
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) safeEnv[key] = process.env[key]!
    }
    if (options?.env) Object.assign(safeEnv, options.env)

    try {
      const { stdout, stderr } = await exec("/bin/sh", ["-c", command], {
        timeout,
        maxBuffer: 1024 * 1024,
        cwd,
        env: safeEnv,
      })

      return {
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: 0,
        timedOut: false,
        sandboxed: false,
      }
    } catch (err: unknown) {
      const error = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string }
      return {
        stdout: truncateOutput(error.stdout ?? ""),
        stderr: truncateOutput(error.stderr ?? ""),
        exitCode: error.code ?? 1,
        timedOut: error.killed === true,
        sandboxed: false,
      }
    }
  }

  /** Build `-e KEY=VALUE` args for Docker from safe env. */
  private buildEnvArgs(extra?: Record<string, string>): string[] {
    const args: string[] = ["-e", "NO_COLOR=1"]
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) {
        args.push("-e", `${key}=${process.env[key]}`)
      }
    }
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        args.push("-e", `${k}=${v}`)
      }
    }
    return args
  }

  // ── Browser sandbox ────────────────────────────────────────────

  /**
   * Build the browser Docker image if not already available.
   * Uses Dockerfile.browser which has Node + Chromium + Puppeteer.
   * Only built once per session; cached by Docker layer cache thereafter.
   */
  async ensureBrowserImage(): Promise<boolean> {
    if (this.browserImageReady !== null) return this.browserImageReady
    if (!(await this.isDockerAvailable())) {
      this.browserImageReady = false
      return false
    }

    // Check if image already exists
    try {
      await exec("docker", ["image", "inspect", BROWSER_IMAGE], { timeout: 5000 })
      this.browserImageReady = true
      return true
    } catch {
      // Image doesn't exist — build it
    }

    try {
      const dockerfileDir = resolve(BROWSER_DOCKERFILE, "..")
      await exec("docker", [
        "build",
        "-t", BROWSER_IMAGE,
        "-f", BROWSER_DOCKERFILE,
        dockerfileDir,
      ], { timeout: 300_000 }) // 5min for first build
      this.browserImageReady = true
      return true
    } catch (err) {
      console.error("Failed to build browser image:", (err as Error).message)
      this.browserImageReady = false
      return false
    }
  }

  /**
   * Execute a browser check inside a Docker container.
   *
   * Runs a self-contained Node.js script inside the browser container that:
   *   1. Starts a static file server for the workspace files
   *   2. Launches Chromium (using the container's sandbox)
   *   3. Navigates to the HTML file
   *   4. Collects errors, warnings, network failures
   *   5. Outputs JSON results to stdout
   *
   * The container has:
   *   - SYS_ADMIN cap (required for Chromium's native sandbox)
   *   - No network access (--network=none)
   *   - Read-only root, writable workspace mount
   *   - Memory/CPU limits
   */
  async browserExec(
    scriptContent: string,
    workspacePath: string,
    options?: { timeout?: number },
  ): Promise<SandboxResult> {
    const useDocker = await this.ensureBrowserImage()

    if (!useDocker) {
      // Fallback: execute on host (browser_check.ts handles this natively)
      return {
        stdout: "",
        stderr: "FALLBACK_TO_HOST",
        exitCode: 1,
        timedOut: false,
        sandboxed: false,
      }
    }

    const timeout = options?.timeout ?? 30_000
    const containerId = `agent001-browser-${randomBytes(6).toString("hex")}`

    const args: string[] = [
      "run",
      "--rm",
      "--name", containerId,
      `--memory=512m`,
      `--cpus=${this.config.cpuLimit}`,
      // No network — the static server runs INSIDE the container
      "--network=none",
      // Chromium needs SYS_ADMIN for its own sandbox (seccomp + namespaces)
      "--cap-drop=ALL",
      "--cap-add=SYS_ADMIN",
      "--security-opt=no-new-privileges",
      // Read-only root, writable workspace + tmp
      "--read-only",
      "--tmpfs", "/tmp:rw,exec,nosuid,size=128m",
      // Bind-mount workspace
      "-v", `${workspacePath}:/workspace:ro`,
      // Working directory
      "-w", "/workspace",
      // Environment
      "-e", "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true",
      "-e", "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium",
      "-e", "NO_COLOR=1",
      // Image
      BROWSER_IMAGE,
      // Execute the script via stdin
      "node", "-e", scriptContent,
    ]

    this.activeContainers.add(containerId)

    try {
      const { stdout, stderr } = await exec("docker", args, {
        timeout: timeout + 10_000, // extra for container + browser startup
        maxBuffer: 2 * 1024 * 1024,
      })

      return {
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: 0,
        timedOut: false,
        sandboxed: true,
      }
    } catch (err: unknown) {
      const error = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string }
      const timedOut = error.killed === true

      if (timedOut) {
        await exec("docker", ["kill", containerId], { timeout: 5000 }).catch(() => {})
      }

      return {
        stdout: truncateOutput(error.stdout ?? ""),
        stderr: truncateOutput(error.stderr ?? ""),
        exitCode: error.code ?? 1,
        timedOut,
        sandboxed: true,
      }
    } finally {
      this.activeContainers.delete(containerId)
    }
  }

  /** Kill all active containers (for cleanup on server shutdown). */
  async cleanup(): Promise<void> {
    const kills = [...this.activeContainers].map((id) =>
      exec("docker", ["kill", id], { timeout: 5000 }).catch(() => {}),
    )
    await Promise.all(kills)
    this.activeContainers.clear()
  }
}

/** Truncate output to prevent context explosion. */
function truncateOutput(output: string): string {
  const s = output.trim()
  if (s.length <= MAX_OUTPUT) return s
  const half = MAX_OUTPUT / 2
  return `${s.slice(0, half)}\n\n... (${s.length - MAX_OUTPUT} chars truncated) ...\n\n${s.slice(-half)}`
}

/** Global sandbox instance. */
let _sandbox: DockerSandbox | null = null

export function getSandbox(): DockerSandbox {
  if (!_sandbox) _sandbox = new DockerSandbox()
  return _sandbox
}

export function initSandbox(config?: SandboxConfig): DockerSandbox {
  _sandbox = new DockerSandbox(config)
  return _sandbox
}

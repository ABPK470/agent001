import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { WorkspaceMountMode } from "../../shared/enums/sandbox.js"
import {
  BROWSER_DOCKERFILE,
  BROWSER_IMAGE,
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_IMAGE,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_CPU,
  DEFAULT_MAX_LIFETIME,
  DEFAULT_MAX_MEMORY,
  DEFAULT_TIMEOUT,
  DEFAULT_WORKSPACE_ACCESS,
  SAFE_ENV_KEYS,
  Semaphore,
  WATCHDOG_INTERVAL,
  truncateOutput
} from "./helpers.js"
import type { SandboxConfig, SandboxResult, TrackedContainer } from "./types.js"

const exec = promisify(execFile)

export class DockerSandbox {
  private dockerAvailable: boolean | null = null
  private browserImageReady: boolean | null = null
  private readonly config: Required<SandboxConfig>
  private activeContainers = new Set<string>()
  private trackedContainers = new Map<string, TrackedContainer>()
  private semaphore: Semaphore
  private watchdogTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: SandboxConfig = {}) {
    this.config = {
      mode: config.mode ?? "docker",
      image: config.image ?? DEFAULT_IMAGE,
      maxMemory: config.maxMemory ?? DEFAULT_MAX_MEMORY,
      maxCpu: config.maxCpu ?? DEFAULT_MAX_CPU,
      maxConcurrent: config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT,
      maxLifetimeMs: config.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME,
      workspaceAccess: config.workspaceAccess ?? DEFAULT_WORKSPACE_ACCESS,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      network: config.network ?? false
    }
    this.semaphore = new Semaphore(this.config.maxConcurrent)
    this.startWatchdog()
  }

  // ── Container lifecycle watchdog ──────────────────────────────

  private startWatchdog(): void {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(() => void this.reapContainers(), WATCHDOG_INTERVAL)
    this.watchdogTimer.unref()
  }

  private async reapContainers(): Promise<void> {
    const now = Date.now()
    for (const [id, info] of this.trackedContainers) {
      const lifetime = now - info.startedAt
      const idle = now - info.lastActivityAt
      if (lifetime > this.config.maxLifetimeMs || idle > this.config.idleTimeoutMs) {
        console.log(
          `🧹 Reaping container ${id} (lifetime=${Math.round(lifetime / 1000)}s, idle=${Math.round(idle / 1000)}s)`
        )
        await exec("docker", ["kill", id], { timeout: 5000 }).catch(() => {})
        this.trackedContainers.delete(id)
        this.activeContainers.delete(id)
      }
    }
  }

  // ── Docker availability ───────────────────────────────────────

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

  async isSandboxed(): Promise<boolean> {
    if (this.config.mode === "host") return false
    return this.isDockerAvailable()
  }

  get isStrictMode(): boolean {
    return this.config.mode === "all"
  }

  get mode(): "all" | "docker" | "host" {
    return this.config.mode
  }

  // ── Main exec entry point ─────────────────────────────────────

  async exec(
    command: string,
    workspacePath: string,
    options?: {
      timeout?: number
      cwd?: string
      env?: Record<string, string>
      network?: boolean
      signal?: AbortSignal
    }
  ): Promise<SandboxResult> {
    const useDocker = await this.isSandboxed()

    if (!useDocker) {
      if (this.config.mode === "all") {
        return {
          stdout: "",
          stderr:
            "Docker is required but unavailable. Install Docker or set SANDBOX_MODE=docker to allow host fallback.",
          exitCode: 1,
          timedOut: false,
          sandboxed: false
        }
      }
      return this.execHost(command, workspacePath, options)
    }

    return this.execDocker(command, workspacePath, options)
  }

  // ── Docker execution ──────────────────────────────────────────

  private async execDocker(
    command: string,
    workspacePath: string,
    options?: {
      timeout?: number
      cwd?: string
      env?: Record<string, string>
      network?: boolean
      signal?: AbortSignal
    }
  ): Promise<SandboxResult> {
    const timeout = options?.timeout ?? this.config.timeout
    const containerCwd = options?.cwd ? `/workspace/${options.cwd}` : "/workspace"
    const allowNetwork = options?.network ?? this.config.network
    const containerId = `mia-sandbox-${randomBytes(6).toString("hex")}`
    const mountArgs = this.buildWorkspaceMount(workspacePath)

    const args: string[] = [
      "run",
      "--rm",
      "--name",
      containerId,
      `--memory=${this.config.maxMemory}`,
      `--cpus=${this.config.maxCpu}`,
      "--oom-kill-disable=false",
      ...(allowNetwork ? [] : ["--network=none"]),
      "--user",
      "1000:1000",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      ...mountArgs,
      "-w",
      containerCwd,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      ...this.buildEnvArgs(options?.env),
      this.config.image,
      "/bin/sh",
      "-c",
      command
    ]

    await this.semaphore.acquire(this.config.timeout)

    const now = Date.now()
    this.activeContainers.add(containerId)
    this.trackedContainers.set(containerId, { startedAt: now, lastActivityAt: now })

    const killOnAbort = options?.signal
      ? () => {
          exec("docker", ["kill", containerId], { timeout: 5000 }).catch(() => {})
        }
      : undefined
    if (killOnAbort) options!.signal!.addEventListener("abort", killOnAbort, { once: true })

    try {
      const { stdout, stderr } = await exec("docker", args, {
        timeout: timeout + 5000,
        maxBuffer: 2 * 1024 * 1024
      })
      return {
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: 0,
        timedOut: false,
        sandboxed: true
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
        sandboxed: true
      }
    } finally {
      if (killOnAbort) options!.signal!.removeEventListener("abort", killOnAbort)
      this.trackedContainers.delete(containerId)
      this.activeContainers.delete(containerId)
      this.semaphore.release()
    }
  }

  // ── Host fallback execution ───────────────────────────────────

  private async execHost(
    command: string,
    workspacePath: string,
    options?: { timeout?: number; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }
  ): Promise<SandboxResult> {
    const timeout = options?.timeout ?? this.config.timeout
    const cwd = options?.cwd ? `${workspacePath}/${options.cwd}` : workspacePath

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
        ...(options?.signal ? { signal: options.signal } : {})
      })
      return {
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: 0,
        timedOut: false,
        sandboxed: false
      }
    } catch (err: unknown) {
      const error = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string }
      return {
        stdout: truncateOutput(error.stdout ?? ""),
        stderr: truncateOutput(error.stderr ?? ""),
        exitCode: error.code ?? 1,
        timedOut: error.killed === true,
        sandboxed: false
      }
    }
  }

  // ── Mount / env helpers ───────────────────────────────────────

  buildWorkspaceMount(workspacePath: string, overrideAccess?: SandboxConfig["workspaceAccess"]): string[] {
    const access = overrideAccess ?? this.config.workspaceAccess
    switch (access) {
      case WorkspaceMountMode.None:
        return []
      case WorkspaceMountMode.Readonly:
        return ["-v", `${workspacePath}:/workspace:ro`]
      case WorkspaceMountMode.Readwrite:
      default:
        return ["-v", `${workspacePath}:/workspace:rw`]
    }
  }

  buildEnvArgs(extra?: Record<string, string>): string[] {
    const args: string[] = ["-e", "NO_COLOR=1"]
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) args.push("-e", `${key}=${process.env[key]}`)
    }
    if (extra) {
      for (const [k, v] of Object.entries(extra)) args.push("-e", `${k}=${v}`)
    }
    return args
  }

  // ── Browser sandbox ───────────────────────────────────────────

  async ensureBrowserImage(): Promise<boolean> {
    if (this.browserImageReady !== null) return this.browserImageReady
    if (!(await this.isDockerAvailable())) {
      this.browserImageReady = false
      return false
    }
    try {
      await exec("docker", ["image", "inspect", BROWSER_IMAGE], { timeout: 5000 })
      this.browserImageReady = true
      return true
    } catch {
      /* Image doesn't exist — build it */
    }

    try {
      const dockerfileDir = resolve(BROWSER_DOCKERFILE, "..")
      await exec("docker", ["build", "-t", BROWSER_IMAGE, "-f", BROWSER_DOCKERFILE, dockerfileDir], {
        timeout: 300_000
      })
      this.browserImageReady = true
      return true
    } catch (err) {
      console.error("Failed to build browser image:", (err as Error).message)
      this.browserImageReady = false
      return false
    }
  }

  async browserExec(
    scriptContent: string,
    workspacePath: string,
    options?: { timeout?: number }
  ): Promise<SandboxResult> {
    const useDocker = await this.ensureBrowserImage()
    if (!useDocker) {
      return { stdout: "", stderr: "FALLBACK_TO_HOST", exitCode: 1, timedOut: false, sandboxed: false }
    }

    const timeout = options?.timeout ?? 30_000
    const containerId = `mia-browser-${randomBytes(6).toString("hex")}`

    const args: string[] = [
      "run",
      "--rm",
      "--name",
      containerId,
      `--memory=${this.config.maxMemory}`,
      `--cpus=${this.config.maxCpu}`,
      "--oom-kill-disable=false",
      "--network=none",
      "--cap-drop=ALL",
      "--cap-add=SYS_ADMIN",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,size=128m",
      ...this.buildWorkspaceMount(workspacePath, WorkspaceMountMode.Readonly),
      "-w",
      "/workspace",
      "-e",
      "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
      "-e",
      "NO_COLOR=1",
      BROWSER_IMAGE,
      "node",
      "-e",
      scriptContent
    ]

    await this.semaphore.acquire(timeout)

    const now = Date.now()
    this.activeContainers.add(containerId)
    this.trackedContainers.set(containerId, { startedAt: now, lastActivityAt: now })

    try {
      const { stdout, stderr } = await exec("docker", args, {
        timeout: timeout + 10_000,
        maxBuffer: 2 * 1024 * 1024
      })
      return {
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: 0,
        timedOut: false,
        sandboxed: true
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
        sandboxed: true
      }
    } finally {
      this.trackedContainers.delete(containerId)
      this.activeContainers.delete(containerId)
      this.semaphore.release()
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    const kills = [...this.activeContainers].map((id) =>
      exec("docker", ["kill", id], { timeout: 5000 }).catch(() => {})
    )
    await Promise.all(kills)
    this.trackedContainers.clear()
    this.activeContainers.clear()
  }
}

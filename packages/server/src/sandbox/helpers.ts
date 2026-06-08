import { resolve } from "node:path"
import { WorkspaceMountMode } from "../enums/sandbox.js"

// ── Constants ────────────────────────────────────────────────────

export const DEFAULT_IMAGE = "node:20-slim"
export const BROWSER_IMAGE = "mia-browser:playwright"
export const BROWSER_DOCKERFILE = resolve(import.meta.dirname, "../../docker/Dockerfile.browser")
export const DEFAULT_MAX_MEMORY = "4g"
export const DEFAULT_MAX_CPU = "2.0"
export const DEFAULT_MAX_CONCURRENT = 4
export const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000 // 30 min
export const DEFAULT_MAX_LIFETIME = 5 * 60 * 1000 // 5 min
export const DEFAULT_WORKSPACE_ACCESS = WorkspaceMountMode.Readwrite
export const DEFAULT_TIMEOUT = 30_000
export const MAX_OUTPUT = 16_000
export const WATCHDOG_INTERVAL = 60_000 // check every 60s

/** Safe environment variables to forward into the container. */
export const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "NODE_ENV"
])

// ── Concurrency semaphore ─────────────────────────────────────────

export class Semaphore {
  private current = 0
  private readonly waiting: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = []

  constructor(private readonly max: number) {}

  get active(): number {
    return this.current
  }

  acquire(timeoutMs = 60_000): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        resolve: () => {
          /* replaced below */
        },
        timer: setTimeout(() => {
          const idx = this.waiting.indexOf(entry)
          if (idx !== -1) {
            this.waiting.splice(idx, 1)
            reject(new Error(`Concurrency limit reached (${this.max} containers). Try again later.`))
          }
        }, timeoutMs)
      }
      entry.resolve = () => {
        clearTimeout(entry.timer)
        this.current++
        resolve()
      }
      this.waiting.push(entry)
    })
  }

  release(): void {
    const next = this.waiting.shift()
    if (next) {
      next.resolve()
    } else {
      this.current--
    }
  }
}

// ── Output truncation ─────────────────────────────────────────────

/** Truncate output to prevent context explosion. */
export function truncateOutput(output: string): string {
  const s = output.trim()
  if (s.length <= MAX_OUTPUT) return s
  const half = MAX_OUTPUT / 2
  return `${s.slice(0, half)}\n\n... (${s.length - MAX_OUTPUT} chars truncated) ...\n\n${s.slice(-half)}`
}

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/** Read `KEY=value` pairs from a dotenv file (no expansion). */
export function parseEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = ENV_LINE.exec(trimmed)
    if (!match) continue
    out.set(match[1]!, unquoteEnvValue(match[2]!.trim()))
  }
  return out
}

function unquoteEnvValue(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  return raw
}

function quoteEnvValue(value: string): string {
  if (/[\s#"'\\]/.test(value)) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  return value
}

/**
 * Merge non-empty updates into `.env`. Never writes empty strings (won't wipe secrets).
 * Creates from `.env.example` when the file is missing.
 */
export function mergeEnvFile(
  envPath: string,
  updates: Record<string, string | undefined>,
  opts?: { examplePath?: string },
): void {
  if (!existsSync(envPath) && opts?.examplePath && existsSync(opts.examplePath)) {
    copyFileSync(opts.examplePath, envPath)
  }

  const pending = new Map(
    Object.entries(updates).filter((entry): entry is [string, string] => {
      const value = entry[1]
      return value !== undefined && value !== ""
    }),
  )
  if (pending.size === 0) return

  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : []
  const out: string[] = []
  let touched = false

  for (const line of lines) {
    const trimmed = line.trim()
    const match = trimmed && !trimmed.startsWith("#") ? ENV_LINE.exec(trimmed) : null
    if (match && pending.has(match[1]!)) {
      out.push(`${match[1]}=${quoteEnvValue(pending.get(match[1]!)!)}`)
      pending.delete(match[1]!)
      touched = true
    } else {
      out.push(line)
    }
  }

  if (pending.size > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("")
    if (!touched) out.push("# ── MI:A setup ────────────────────────────────────────────────")
    for (const [key, value] of pending) {
      out.push(`${key}=${quoteEnvValue(value)}`)
    }
  }

  writeFileSync(envPath, `${out.join("\n").replace(/\n+$/, "")}\n`, "utf8")
}

/** Reload merged keys into the current process after writing `.env`. */
export function applyEnvToProcess(updates: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== "") process.env[key] = value
  }
}

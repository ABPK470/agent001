import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..")

const FORBIDDEN = [
  /flow-step-field:/,
  /prior-step-output:/,
  /"entity-id"/,
  /"metadata-sync"/,
  /\bfrom:\s*["'][a-z]+-/,
]

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "migrations"])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walk(path, out)
      continue
    }
    if (/\.(ts|tsx|json)$/.test(entry)) out.push(path)
  }
  return out
}

function isProductionSource(file: string): boolean {
  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return false
  if (file.includes("wire-convention-guard.test.ts")) return false
  if (file.includes("/fixtures/")) return false
  return true
}

describe("wire convention guard", () => {
  it("does not reintroduce legacy string binding grammars in production sources", () => {
    const roots = [
      join(repoRoot, "packages"),
      join(repoRoot, "deploy/sync/artifacts"),
      join(repoRoot, "sync-definitions/published"),
    ]
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!isProductionSource(file)) continue
        const text = readFileSync(file, "utf-8")
        for (const pattern of FORBIDDEN) {
          if (pattern.test(text)) {
            offenders.push(`${file}: ${pattern}`)
            break
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

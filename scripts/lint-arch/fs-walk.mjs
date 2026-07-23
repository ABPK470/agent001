import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** Recursive walk for .ts / .tsx (skips node_modules + dist). */
export function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full)
  }
  return out
}

export function isTestFile(relPath) {
  return relPath.endsWith(".test.ts") || relPath.endsWith(".test.tsx")
}

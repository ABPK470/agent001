import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/** Load optional per-connector knowledge markdown (injected into the LLM system prompt). */
export function readKnowledgeFile(projectRoot: string, filePath: string): string | null {
  const resolved = resolve(projectRoot, filePath)
  try {
    if (!existsSync(resolved)) {
      console.warn(`MSSQL knowledge file not found: ${resolved}`)
      return null
    }
    const content = readFileSync(resolved, "utf-8").trim()
    if (!content) return null
    console.log(`MSSQL knowledge loaded: ${resolved} (${content.length} chars)`)
    return content
  } catch (e) {
    console.warn(`Failed to read MSSQL knowledge file: ${resolved}`, e instanceof Error ? e.message : e)
    return null
  }
}

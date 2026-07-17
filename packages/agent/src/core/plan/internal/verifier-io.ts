/**
 * Verifier I/O — artifact probing, content reading, and path extraction.
 *
 * Extracted from verifier.ts.
 *
 * @module
 */

import { normalizeToolExecutionOutput } from "../../tools/index.js"
import type { Tool } from "../../types.js"

// ============================================================================
// Tool execution
// ============================================================================

export async function executeToolForText(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return normalizeToolExecutionOutput(await tool.execute(args)).result
}

// ============================================================================
// Path extraction
// ============================================================================

export function extractActualPaths(output: string): string[] {
  const paths: string[] = []
  for (const m of output.matchAll(/`([^`\s]+\.[a-zA-Z0-9]+)`/g)) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  for (const m of output.matchAll(
    /(?:creat|writ|wrote|modif|generat|saved)\w*\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi
  )) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  return [...new Set(paths)]
}

// ============================================================================
// Artifact probing
// ============================================================================

export async function probeArtifact(
  readFile: Tool,
  plannedPath: string,
  actualPaths: string[],
  workspaceRoot?: string,
  runCommand?: Tool,
  allowedWriteRoots?: readonly string[]
): Promise<{ found: boolean; resolvedPath: string }> {
  const candidates: string[] = []
  const hasAbsoluteWsRoot = Boolean(workspaceRoot && workspaceRoot.startsWith("/"))
  if (workspaceRoot && !plannedPath.startsWith(workspaceRoot)) {
    const rooted = workspaceRoot.endsWith("/")
      ? `${workspaceRoot}${plannedPath}`
      : `${workspaceRoot}/${plannedPath}`
    candidates.push(rooted)
  }
  if (!hasAbsoluteWsRoot || plannedPath.startsWith("/")) {
    candidates.push(plannedPath)
  }

  if (allowedWriteRoots && workspaceRoot && !plannedPath.includes("/")) {
    const wsNorm = workspaceRoot.replace(/\/$/, "")
    for (const wr of allowedWriteRoots) {
      const wrNorm = wr.replace(/\/$/, "")
      if (wrNorm !== wsNorm && wrNorm.startsWith(wsNorm + "/")) {
        const subdir = wrNorm.slice(wsNorm.length + 1)
        candidates.push(`${subdir}/${plannedPath}`)
      } else if (!wrNorm.startsWith("/") && wrNorm !== "." && wrNorm !== "./") {
        candidates.push(`${wrNorm}/${plannedPath}`)
      }
    }
  }

  // 1. Try planned path (and workspace-rooted variant)
  for (const candidate of candidates) {
    try {
      const content = await executeToolForText(readFile, { path: candidate })
      if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
        return { found: true, resolvedPath: candidate }
      }
    } catch {
      /* fall through */
    }

    if (runCommand) {
      try {
        const exists = await executeToolForText(runCommand, {
          command: `if [ -f ${JSON.stringify(candidate)} ]; then echo __FOUND__; else echo __MISSING__; fi`
        })
        if (/__FOUND__/.test(exists)) {
          return { found: true, resolvedPath: candidate }
        }
      } catch {
        /* fall through */
      }
    }
  }

  // 2. Try to match against paths the child actually wrote
  const basename = plannedPath.split("/").pop() ?? plannedPath
  for (const actual of actualPaths) {
    if (actual === plannedPath || actual.endsWith(`/${plannedPath}`) || actual.endsWith(`/${basename}`)) {
      try {
        const content = await executeToolForText(readFile, { path: actual })
        if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
          return { found: true, resolvedPath: actual }
        }
      } catch {
        /* fall through */
      }
    }
  }

  // 3. Last resort: search with find, scoped to workspaceRoot
  if (runCommand && basename) {
    try {
      const searchRoot = workspaceRoot || "."
      const findResult = await executeToolForText(runCommand, {
        command: `find ${JSON.stringify(searchRoot)} -maxdepth 5 -name ${JSON.stringify(basename)} -type f -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.git/*" 2>/dev/null | head -5`
      })
      const foundPaths = findResult
        .trim()
        .split("\n")
        .filter((p: string) => p.length > 0 && p !== "." && !p.includes("(no output)"))
        .map((p: string) => p.replace(/^\.\//, ""))
      for (const fp of foundPaths) {
        try {
          const content = await executeToolForText(readFile, { path: fp })
          if (
            !content.startsWith("Error:") &&
            !content.includes("not found") &&
            !content.includes("ENOENT")
          ) {
            return { found: true, resolvedPath: fp }
          }
        } catch {
          /* fall through */
        }
        if (runCommand) {
          try {
            const exists = await executeToolForText(runCommand, {
              command: `if [ -f ${JSON.stringify(fp)} ]; then echo __FOUND__; else echo __MISSING__; fi`
            })
            if (/__FOUND__/.test(exists)) {
              return { found: true, resolvedPath: fp }
            }
          } catch {
            /* fall through */
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 4. Second-chance find with relative "."
  if (runCommand && basename) {
    try {
      const findResult2 = await executeToolForText(runCommand, {
        command: `find . -maxdepth 6 -name ${JSON.stringify(basename)} -type f -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -5`
      })
      const foundPaths2 = findResult2
        .trim()
        .split("\n")
        .filter((p: string) => p.length > 0 && p !== "." && !p.includes("(no output)"))
        .map((p: string) => p.replace(/^\.\//, ""))
      for (const fp of foundPaths2) {
        try {
          const content = await executeToolForText(readFile, { path: fp })
          if (
            !content.startsWith("Error:") &&
            !content.includes("not found") &&
            !content.includes("ENOENT")
          ) {
            return { found: true, resolvedPath: fp }
          }
        } catch {
          /* fall through */
        }
        if (runCommand) {
          try {
            const exists = await executeToolForText(runCommand, {
              command: `if [ -f ${JSON.stringify(fp)} ]; then echo __FOUND__; else echo __MISSING__; fi`
            })
            if (/__FOUND__/.test(exists)) {
              return { found: true, resolvedPath: fp }
            }
          } catch {
            /* fall through */
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  return { found: false, resolvedPath: plannedPath }
}

// ============================================================================
// Artifact content reading
// ============================================================================

export async function readArtifactContent(
  readFile: Tool,
  path: string,
  runCommand?: Tool
): Promise<string | null> {
  try {
    const content = await executeToolForText(readFile, { path })
    if (/^Error:\s*(?:ENOENT|ENOTDIR|EISDIR|EACCES|EPERM|Path|Symlink|A parent directory)/i.test(content)) {
      throw new Error(content)
    }
    return content
  } catch {
    if (!runCommand) return null
    try {
      const raw = await executeToolForText(runCommand, {
        command: `if [ -f ${JSON.stringify(path)} ]; then cat ${JSON.stringify(path)}; else echo __MISSING__; fi`
      })
      if (raw.trim() === "__MISSING__") return null
      return raw
    } catch {
      return null
    }
  }
}

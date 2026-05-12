/**
 * Shared types, utilities, and helpers for integration probes.
 *
 * @module
 */

import { posix as pathPosix } from "node:path"
import { normalizeToolExecutionOutput } from "../../tool-utils.js"
import type { Tool } from "../../types.js"
import { normalizeSpecPath } from "../blueprint-contract.js"
import type { Plan, SubagentTaskStep, VerifierStepAssessment } from "../types.js"
import {
    extractDefinedCssClasses,
    extractReferencedCssClassesFromHtml,
    extractReferencedCssClassesFromScript,
} from "../verifier-helpers.js"
import { extractModuleImports } from "./module-imports.js"

// ============================================================================
// Types
// ============================================================================

export interface IntegrationArtifact {
  path: string
  stepName: string
}

export interface IntegrationProbeContext {
  plan: Plan
  toolMap: Map<string, Tool>
  assessments: VerifierStepAssessment[]
  allArtifacts: readonly IntegrationArtifact[]
}

export type { ModuleImportRef } from "./module-imports.js"

export type IntegrationProbe = (ctx: IntegrationProbeContext) => Promise<void>
export type ReadArtifactContent = (readFile: Tool, path: string, runCommand?: Tool) => Promise<string | null>
export type ProbeArtifact = (readFile: Tool, path: string, actualPaths: string[], wsRoot?: string, runCommand?: Tool, allowedWriteRoots?: readonly string[]) => Promise<{ found: boolean; resolvedPath: string }>

// ============================================================================
// Shared utilities (also used by verifier.ts for artifact reading)
// ============================================================================

export function collectIntegrationArtifacts(plan: Plan): IntegrationArtifact[] {
  const artifacts: IntegrationArtifact[] = []
  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    for (const artifact of sa.executionContext.targetArtifacts) {
      artifacts.push({ path: artifact, stepName: step.name })
    }
  }
  return artifacts
}

export function findWsRootForStep(plan: Plan, stepName: string): string | undefined {
  const step = plan.steps.find(s => s.name === stepName)
  if (step?.stepType === "subagent_task") {
    return (step as SubagentTaskStep).executionContext.workspaceRoot || undefined
  }
  return undefined
}

// ============================================================================
// Shared reading helpers
// ============================================================================

export async function readIntegrationArtifactContents(
  artifacts: readonly IntegrationArtifact[],
  readFile: Tool,
  readArtifactContent: ReadArtifactContent,
  runCommand?: Tool,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>()
  for (const artifact of artifacts) {
    try {
      const raw = await readArtifactContent(readFile, artifact.path, runCommand)
      if (typeof raw === "string" && raw.length > 0) {
        contents.set(normalizeSpecPath(artifact.path), raw)
      }
    } catch { /* ignore */ }
  }
  return contents
}

export async function executeToolForText(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return normalizeToolExecutionOutput(await tool.execute(args)).result
}

export async function readArtifactContentViaTool(
  readFile: Tool,
  path: string,
  runCommand?: Tool,
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
        command: `if [ -f ${JSON.stringify(path)} ]; then cat ${JSON.stringify(path)}; else echo __MISSING__; fi`,
      })
      if (raw.trim() === "__MISSING__") return null
      return raw
    } catch {
      return null
    }
  }
}

export async function probeArtifactViaTool(
  readFile: Tool,
  path: string,
  _actualPaths: string[],
  wsRoot?: string,
  _runCommand?: Tool,
): Promise<{ found: boolean; resolvedPath: string }> {
  const candidates: string[] = []
  if (wsRoot && !path.startsWith(wsRoot)) {
    const rooted = wsRoot.endsWith("/") ? `${wsRoot}${path}` : `${wsRoot}/${path}`
    candidates.push(rooted)
  }
  candidates.push(path)

  for (const candidate of candidates) {
    try {
      const content = await executeToolForText(readFile, { path: candidate })
      if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
        return { found: true, resolvedPath: candidate }
      }
    } catch { /* fall through */ }
  }

  return { found: false, resolvedPath: path }
}

// Module import/export extraction lives in ./module-imports.ts
export { extractModuleExports, extractModuleImports } from "./module-imports.js"

// ============================================================================
// Script reference extraction
// ============================================================================

export function extractHtmlScriptRefs(htmlContent: string): Array<{ src: string; isModule: boolean }> {
  const refs: Array<{ src: string; isModule: boolean }> = []
  const scriptTagRe = /<script\b([^>]*)src\s*=\s*["']([^"']+)["']([^>]*)>/gi
  let match: RegExpExecArray | null
  while ((match = scriptTagRe.exec(htmlContent)) !== null) {
    const attrs = `${match[1] ?? ""} ${match[3] ?? ""}`
    refs.push({
      src: match[2],
      isModule: /\btype\s*=\s*["']module["']/i.test(attrs),
    })
  }
  return refs
}

// ============================================================================
// Artifact reference resolution
// ============================================================================

export function resolveArtifactReference(
  fromArtifactPath: string,
  reference: string,
  artifacts: readonly IntegrationArtifact[],
): { path: string; basename: string } | null {
  const normalizedRef = reference.trim().replace(/^\.\//, "")
  if (!normalizedRef) return null
  const normalizedFrom = normalizeSpecPath(fromArtifactPath)
  const byRelativePath = normalizeSpecPath(pathPosix.join(pathPosix.dirname(normalizedFrom), normalizedRef))
  const candidates = [normalizedRef, byRelativePath]

  for (const candidate of candidates) {
    const match = artifacts.find(artifact => normalizeSpecPath(artifact.path) === candidate)
    if (match) {
      return { path: normalizeSpecPath(match.path), basename: match.path.split("/").pop() ?? match.path }
    }
  }

  const basename = normalizedRef.split("/").pop() ?? normalizedRef
  const basenameMatches = artifacts.filter(artifact => (artifact.path.split("/").pop() ?? artifact.path) === basename)
  if (basenameMatches.length === 1) {
    const match = basenameMatches[0]
    return { path: normalizeSpecPath(match.path), basename }
  }
  return null
}

export function resolveArtifactImport(
  fromArtifactPath: string,
  specifier: string,
  artifacts: readonly IntegrationArtifact[],
): { path: string; basename: string } | null {
  if (!specifier.startsWith(".")) return null
  return resolveArtifactReference(fromArtifactPath, specifier, artifacts)
}

// ============================================================================
// Reachability analysis
// ============================================================================

export function collectReachableRuntimeArtifacts(
  htmlPath: string,
  scriptRefs: readonly { src: string; isModule: boolean }[],
  relatedJs: readonly IntegrationArtifact[],
  contents: ReadonlyMap<string, string>,
): Set<string> {
  const reachable = new Set<string>()
  const queue: string[] = []

  for (const scriptRef of scriptRefs) {
    const resolved = resolveArtifactReference(htmlPath, scriptRef.src, relatedJs)
    if (!resolved) continue
    if (!reachable.has(resolved.path)) {
      reachable.add(resolved.path)
      queue.push(resolved.path)
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!
    const content = contents.get(current)
    if (!content) continue
    for (const imported of extractModuleImports(content)) {
      const resolved = resolveArtifactImport(current, imported.specifier, relatedJs)
      if (!resolved || reachable.has(resolved.path)) continue
      reachable.add(resolved.path)
      queue.push(resolved.path)
    }
  }

  return reachable
}

// Re-exports for CSS helpers needed by probes
export { extractDefinedCssClasses, extractReferencedCssClassesFromHtml, extractReferencedCssClassesFromScript }

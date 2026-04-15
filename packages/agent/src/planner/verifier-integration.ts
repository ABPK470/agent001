/**
 * Verifier integration probes — cross-step artifact integration checks.
 *
 * Detects: missing script references, module compatibility issues,
 * CSS class contract violations, import/export mismatches, cross-file
 * function signature drift.
 *
 * Extracted from verifier.ts.
 *
 * @module
 */

import type { Tool } from "../types.js"
import { normalizeSpecPath } from "./blueprint-contract.js"
import type {
    Plan,
    SubagentTaskStep,
    VerifierStepAssessment,
} from "./types.js"
import {
    extractDefinedCssClasses,
    extractReferencedCssClassesFromHtml,
    extractReferencedCssClassesFromScript,
} from "./verifier-helpers.js"

// ============================================================================
// Types
// ============================================================================

export interface IntegrationArtifact {
  path: string
  stepName: string
}

interface IntegrationProbeContext {
  plan: Plan
  toolMap: Map<string, Tool>
  assessments: VerifierStepAssessment[]
  allArtifacts: readonly IntegrationArtifact[]
}

interface ModuleImportRef {
  readonly specifier: string
  readonly importedNames: readonly string[]
  readonly defaultImport?: string
  readonly namespaceImport?: string
}

type IntegrationProbe = (ctx: IntegrationProbeContext) => Promise<void>

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
// Entry point
// ============================================================================

export async function runIntegrationProbes(
  plan: Plan,
  _pipelineResult: unknown,
  toolMap: Map<string, Tool>,
  assessments: VerifierStepAssessment[],
): Promise<void> {
  const allArtifacts = collectIntegrationArtifacts(plan)
  const ctx: IntegrationProbeContext = {
    plan,
    toolMap,
    assessments,
    allArtifacts,
  }

  const probes: readonly IntegrationProbe[] = [
    probeWebEntrypointRuntimeWiring,
    probeBrowserModuleCompatibility,
    probeCssClassContracts,
    probeLocalModuleImportBindings,
    probeCrossFileFunctionSignatures,
  ]
  for (const probe of probes) {
    await probe(ctx)
  }
}

// ============================================================================
// Shared reading helpers
// ============================================================================

async function readIntegrationArtifactContents(
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

type ReadArtifactContent = (readFile: Tool, path: string, runCommand?: Tool) => Promise<string | null>
type ProbeArtifact = (readFile: Tool, path: string, actualPaths: string[], wsRoot?: string, runCommand?: Tool, allowedWriteRoots?: readonly string[]) => Promise<{ found: boolean; resolvedPath: string }>

// We inject readArtifactContent and probeArtifact from verifier.ts.
// However for a clean module, the integration probes use the toolMap directly.
// We'll adapt by using executeToolForText internally.

import { normalizeToolExecutionOutput } from "../tool-utils.js"

async function executeToolForText(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return normalizeToolExecutionOutput(await tool.execute(args)).result
}

async function readArtifactContentViaTool(
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

async function probeArtifactViaTool(
  readFile: Tool,
  path: string,
  _actualPaths: string[],
  wsRoot?: string,
  runCommand?: Tool,
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

// ============================================================================
// Module import/export extraction
// ============================================================================

function extractModuleImports(code: string): ModuleImportRef[] {
  const imports: ModuleImportRef[] = []
  const importFromRe = /import\s+([^;\n]+?)\s+from\s+["']([^"']+)["']/g
  const sideEffectImportRe = /import\s+["']([^"']+)["']/g
  const exportFromRe = /export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g
  const exportAllFromRe = /export\s+\*\s+from\s+["']([^"']+)["']/g
  const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g

  let match: RegExpExecArray | null
  while ((match = importFromRe.exec(code)) !== null) {
    const clause = (match[1] ?? "").trim()
    const specifier = match[2]
    const importedNames: string[] = []
    let defaultImport: string | undefined
    let namespaceImport: string | undefined

    if (clause.startsWith("{")) {
      importedNames.push(...parseNamedImports(clause))
    } else if (clause.startsWith("* as ")) {
      namespaceImport = clause.replace(/^\*\s+as\s+/, "").trim()
    } else if (clause.includes(",")) {
      const [first, second] = clause.split(",", 2)
      defaultImport = first.trim() || undefined
      const rest = second.trim()
      if (rest.startsWith("{")) importedNames.push(...parseNamedImports(rest))
      if (rest.startsWith("* as ")) namespaceImport = rest.replace(/^\*\s+as\s+/, "").trim()
    } else {
      defaultImport = clause.trim() || undefined
    }

    imports.push({ specifier, importedNames, defaultImport, namespaceImport })
  }

  while ((match = sideEffectImportRe.exec(code)) !== null) {
    const specifier = match[1]
    if (!imports.some(entry => entry.specifier === specifier && entry.importedNames.length === 0 && !entry.defaultImport && !entry.namespaceImport)) {
      imports.push({ specifier, importedNames: [] })
    }
  }

  while ((match = exportFromRe.exec(code)) !== null) {
    imports.push({ specifier: match[2], importedNames: parseNamedImports(`{${match[1]}}`) })
  }

  while ((match = exportAllFromRe.exec(code)) !== null) {
    imports.push({ specifier: match[1], importedNames: [] })
  }

  while ((match = dynamicImportRe.exec(code)) !== null) {
    imports.push({ specifier: match[1], importedNames: [] })
  }

  return imports
}

function parseNamedImports(clause: string): string[] {
  const body = clause.replace(/^\{/, "").replace(/\}$/, "")
  return body
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => entry.split(/\s+as\s+/i)[0]?.trim() ?? "")
    .filter(Boolean)
}

function extractModuleExports(code: string): { named: Set<string>; hasDefault: boolean } {
  const named = new Set<string>()
  let hasDefault = false

  const exportFunctionRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$]\w*)\s*\(/g
  const exportClassRe = /export\s+class\s+([A-Za-z_$]\w*)\b/g
  const exportDeclRe = /export\s+(?:const|let|var)\s+([A-Za-z_$]\w*)\b/g
  const exportNamedRe = /export\s+\{([^}]+)\}/g
  const exportDefaultRe = /export\s+default\b/g

  let match: RegExpExecArray | null
  while ((match = exportFunctionRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportClassRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportDeclRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportNamedRe.exec(code)) !== null) {
    for (const entry of match[1].split(",")) {
      const localName = entry.split(/\s+as\s+/i)[0]?.trim()
      if (localName) named.add(localName)
    }
  }
  while (exportDefaultRe.exec(code) !== null) hasDefault = true

  return { named, hasDefault }
}

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

import { posix as pathPosix } from "node:path"

function resolveArtifactReference(
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

function resolveArtifactImport(
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

function collectReachableRuntimeArtifacts(
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

// ============================================================================
// Integration probes
// ============================================================================

async function probeWebEntrypointRuntimeWiring(ctx: IntegrationProbeContext): Promise<void> {
  const { plan, toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  const htmlArtifacts = allArtifacts.filter(a => /\.html?$/i.test(a.path))
  const jsArtifacts = allArtifacts.filter(a => /\.js$/i.test(a.path))
  if (htmlArtifacts.length === 0 || jsArtifacts.length === 0) return

  for (const htmlEntry of htmlArtifacts) {
    const wsRoot = findWsRootForStep(plan, htmlEntry.stepName)
    const probe = await probeArtifactViaTool(readFile, htmlEntry.path, [], wsRoot, runCommand)
    if (!probe.found) continue

    let htmlContent: string
    try {
      const raw = await readArtifactContentViaTool(readFile, probe.resolvedPath, runCommand)
      if (typeof raw !== "string" || raw.length === 0) continue
      htmlContent = raw
    } catch { continue }

    const htmlDir = htmlEntry.path.replace(/[^/]+$/, "")
    const relatedJs = jsArtifacts.filter(js => {
      const jsDir = js.path.replace(/[^/]+$/, "")
      return jsDir.startsWith(htmlDir)
    })

    if (relatedJs.length === 0) continue

    const scriptRefs = extractHtmlScriptRefs(htmlContent)
    const relatedJsContent = await readIntegrationArtifactContents(relatedJs, readFile, readArtifactContentViaTool, runCommand)
    const reachableRuntimeArtifacts = collectReachableRuntimeArtifacts(htmlEntry.path, scriptRefs, relatedJs, relatedJsContent)

    const missingScripts: string[] = []
    for (const jsEntry of relatedJs) {
      if (!reachableRuntimeArtifacts.has(normalizeSpecPath(jsEntry.path))) {
        const jsBasename = jsEntry.path.split("/").pop() ?? jsEntry.path
        missingScripts.push(jsBasename)
      }
    }

    if (missingScripts.length > 0) {
      const idx = assessments.findIndex(a => a.stepName === htmlEntry.stepName)
      const issue = `Integration gap: entry artifact "${htmlEntry.path}" does not reach related runtime artifacts through module scripts/imports: ${missingScripts.join(", ")}. Runtime code will never load.`
      if (idx >= 0) {
        const existing = assessments[idx]
        assessments[idx] = {
          stepName: existing.stepName,
          outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
          confidence: existing.outcome === "pass" ? 0.4 : existing.confidence,
          issues: [...existing.issues, issue],
          retryable: true,
        }
      }
    }

    // Check that every <script src=...> and <link href=...> reference exists on disk
    const missingRefIssues: string[] = []
    const htmlDirForRef = htmlEntry.path.replace(/[^/]+$/, "")
    for (const scriptRef of scriptRefs) {
      const src = scriptRef.src
      if (/^(?:https?|data|blob):|\/\//i.test(src)) continue
      const resolvedSrc = src.startsWith("/") ? src.replace(/^\//, "") : `${htmlDirForRef}${src}`
      const existsProbe = await probeArtifactViaTool(readFile, resolvedSrc, [], wsRoot, runCommand)
      if (!existsProbe.found) {
        missingRefIssues.push(
          `MISSING_SCRIPT_FILE: "${htmlEntry.path}" has <script src="${src}"> but "${resolvedSrc}" does not exist on disk. ` +
          `The browser will 404 and the page will be non-functional. Either write the missing file or remove the reference.`,
        )
      }
    }
    for (const match of htmlContent.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/giu)) {
      const href = match[1]
      if (/^(?:https?|data|blob):|\/\//i.test(href)) continue
      if (href.startsWith("//fonts.googleapis") || href.startsWith("//fonts.gstatic")) continue
      const resolvedHref = href.startsWith("/") ? href.replace(/^\//, "") : `${htmlDirForRef}${href}`
      const existsProbe = await probeArtifactViaTool(readFile, resolvedHref, [], wsRoot, runCommand)
      if (!existsProbe.found) {
        missingRefIssues.push(
          `MISSING_STYLESHEET_FILE: "${htmlEntry.path}" has <link href="${href}"> but "${resolvedHref}" does not exist on disk. ` +
          `Styles will be missing. Either write the missing CSS file or remove the reference.`,
        )
      }
    }
    if (missingRefIssues.length > 0) {
      const idx = assessments.findIndex(a => a.stepName === htmlEntry.stepName)
      if (idx >= 0) {
        const existing = assessments[idx]
        assessments[idx] = {
          stepName: existing.stepName,
          outcome: "retry",
          confidence: 0.0,
          issues: [...existing.issues, ...missingRefIssues],
          retryable: true,
        }
      }
    }
  }
}

async function probeBrowserModuleCompatibility(ctx: IntegrationProbeContext): Promise<void> {
  const { plan, toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  const htmlArtifacts = allArtifacts.filter(a => /\.(?:html?|xhtml)$/i.test(a.path))
  const jsArtifacts = allArtifacts.filter(a => /\.js$/i.test(a.path))
  if (htmlArtifacts.length === 0 || jsArtifacts.length === 0) return

  for (const htmlEntry of htmlArtifacts) {
    const wsRoot = findWsRootForStep(plan, htmlEntry.stepName)
    const htmlProbe = await probeArtifactViaTool(readFile, htmlEntry.path, [], wsRoot, runCommand)
    if (!htmlProbe.found) continue

    let htmlContent: string
    try {
      const raw = await readArtifactContentViaTool(readFile, htmlProbe.resolvedPath, runCommand)
      if (typeof raw !== "string" || raw.length === 0) continue
      htmlContent = raw
    } catch { continue }

    const htmlDir = htmlEntry.path.replace(/[^/]+$/, "")
    const relatedJs = jsArtifacts.filter(js => {
      const jsDir = js.path.replace(/[^/]+$/, "")
      return jsDir.startsWith(htmlDir) || htmlDir.startsWith(jsDir)
    })
    if (relatedJs.length === 0) continue

    const scriptRefs = extractHtmlScriptRefs(htmlContent)
    const relatedJsContent = await readIntegrationArtifactContents(relatedJs, readFile, readArtifactContentViaTool, runCommand)
    const reachableRuntimeArtifacts = collectReachableRuntimeArtifacts(htmlEntry.path, scriptRefs, relatedJs, relatedJsContent)
    const htmlIssues: string[] = []

    for (const scriptRef of scriptRefs) {
      const resolved = resolveArtifactReference(htmlEntry.path, scriptRef.src, relatedJs)
      if (!resolved || !/\.js$/i.test(resolved.path)) continue
      if (!scriptRef.isModule) {
        const resolvedJsContent = relatedJsContent.get(normalizeSpecPath(resolved.path)) ?? ""
        const usesEsModuleSyntax = /\bimport\s+(?:\{|[\w*]|\*\s+as\s+\w)|\bexport\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|\{)/.test(resolvedJsContent)
        if (!usesEsModuleSyntax) continue
        htmlIssues.push(
          `Browser module mismatch: "${htmlEntry.path}" loads "${resolved.basename}" without type="module", ` +
          `but the file uses ES module import/export syntax. ` +
          `Fix one of: (a) change the HTML tag to <script type="module" src="${resolved.basename}"> and ensure imports resolve via HTTP, ` +
          `or (b) remove all import/export statements and inline helper code into a single script file ` +
          `(simpler and more portable for bundled games and static tools).`,
        )
      }
    }

    for (const jsEntry of relatedJs) {
      const normalizedPath = normalizeSpecPath(jsEntry.path)
      if (!reachableRuntimeArtifacts.has(normalizedPath)) continue

      const jsBasename = jsEntry.path.split("/").pop() ?? jsEntry.path
      const jsContent = relatedJsContent.get(normalizedPath) ?? ""
      if (!jsContent) continue

      const usesCommonJs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]\w*\b|\brequire\s*\(/.test(jsContent)
      const usesWindowGlobals = /\bwindow\.[A-Za-z_$]\w*\s*=/.test(jsContent)

      if (usesCommonJs) {
        htmlIssues.push(
          `Browser module mismatch: "${htmlEntry.path}" reaches "${jsBasename}", but that file uses CommonJS (module.exports/require). Browser runtime files must use ES modules only.`,
        )
      }
      if (usesWindowGlobals) {
        htmlIssues.push(
          `Browser module mismatch: "${htmlEntry.path}" reaches "${jsBasename}", but that file assigns browser globals instead of using ESM imports/exports.`,
        )
      }
    }

    if (htmlIssues.length === 0) continue
    const idx = assessments.findIndex(a => a.stepName === htmlEntry.stepName)
    if (idx >= 0) {
      const existing = assessments[idx]
      assessments[idx] = {
        stepName: existing.stepName,
        outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
        confidence: existing.outcome === "pass" ? 0.35 : existing.confidence,
        issues: [...existing.issues, ...htmlIssues.filter(issue => !existing.issues.includes(issue))],
        retryable: true,
      }
    }
  }
}

async function probeCssClassContracts(ctx: IntegrationProbeContext): Promise<void> {
  const { plan, toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  const cssArtifacts = allArtifacts.filter(a => /\.(?:css|scss|sass|less)$/i.test(a.path))
  const codeArtifacts = allArtifacts.filter(a => /\.(?:js|jsx|ts|tsx|mjs|html?)$/i.test(a.path))
  if (cssArtifacts.length === 0 || codeArtifacts.length === 0) return

  const cssContents = await readIntegrationArtifactContents(cssArtifacts, readFile, readArtifactContentViaTool, runCommand)
  if (cssContents.size === 0) return

  const definedClasses = new Set<string>()
  for (const content of cssContents.values()) {
    for (const cls of extractDefinedCssClasses(content)) definedClasses.add(cls)
  }

  for (const artifact of codeArtifacts) {
    const wsRoot = findWsRootForStep(plan, artifact.stepName)
    const probe = await probeArtifactViaTool(readFile, artifact.path, [], wsRoot, runCommand)
    if (!probe.found) continue
    const content = await readArtifactContentViaTool(readFile, probe.resolvedPath, runCommand)
    if (typeof content !== "string" || content.length === 0) continue

    const referencedClasses = /\.html?$/i.test(artifact.path)
      ? extractReferencedCssClassesFromHtml(content)
      : extractReferencedCssClassesFromScript(content)
    const missingClasses = referencedClasses.filter(cls => !definedClasses.has(cls))
    if (missingClasses.length === 0) continue

    const idx = assessments.findIndex(a => a.stepName === artifact.stepName)
    if (idx < 0) continue

    const existing = assessments[idx]
    const issues = missingClasses.map(cls =>
      `Style integration gap: "${artifact.path}" references CSS class ".${cls}" for UI structure/state, but no related stylesheet defines it.`,
    )
    assessments[idx] = {
      stepName: existing.stepName,
      outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
      confidence: existing.outcome === "pass" ? 0.45 : existing.confidence,
      issues: [...existing.issues, ...issues.filter(issue => !existing.issues.includes(issue))],
      retryable: true,
    }
  }
}

async function probeLocalModuleImportBindings(ctx: IntegrationProbeContext): Promise<void> {
  const { toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  const codeArtifacts = allArtifacts.filter(a => /\.(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(a.path))
  if (codeArtifacts.length < 2) return

  const fileContents = await readIntegrationArtifactContents(codeArtifacts, readFile, readArtifactContentViaTool, runCommand)
  if (fileContents.size < 2) return

  const exportMap = new Map<string, { named: Set<string>; hasDefault: boolean }>()
  for (const artifact of codeArtifacts) {
    const normalizedPath = normalizeSpecPath(artifact.path)
    const content = fileContents.get(normalizedPath)
    if (!content) continue
    exportMap.set(normalizedPath, extractModuleExports(content))
  }

  for (const artifact of codeArtifacts) {
    const normalizedPath = normalizeSpecPath(artifact.path)
    const content = fileContents.get(normalizedPath)
    if (!content) continue

    const issues: string[] = []
    const imports = extractModuleImports(content)
    for (const imported of imports) {
      const resolved = resolveArtifactImport(normalizedPath, imported.specifier, codeArtifacts)
      if (!resolved) continue
      const exports = exportMap.get(resolved.path)
      if (!exports) continue

      if (imported.defaultImport && !exports.hasDefault) {
        issues.push(`Import/export mismatch: ${artifact.path} imports default from ${resolved.basename}, but that module has no default export`)
      }
      for (const importedName of imported.importedNames) {
        if (!exports.named.has(importedName)) {
          issues.push(`Import/export mismatch: ${artifact.path} imports ${importedName} from ${resolved.basename}, but that export is missing`)
        }
      }
    }

    if (issues.length === 0) continue
    const idx = assessments.findIndex(a => a.stepName === artifact.stepName)
    if (idx >= 0) {
      const existing = assessments[idx]
      assessments[idx] = {
        stepName: existing.stepName,
        outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
        confidence: existing.outcome === "pass" ? 0.35 : existing.confidence,
        issues: [...existing.issues, ...issues.filter(issue => !existing.issues.includes(issue))],
        retryable: true,
      }
    }
  }
}

async function probeCrossFileFunctionSignatures(ctx: IntegrationProbeContext): Promise<void> {
  const { toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  if (!readFile) return

  const codeArtifacts = allArtifacts.filter(a => /\.(js|jsx|ts|tsx)$/i.test(a.path))
  if (codeArtifacts.length < 2) return

  const fileContents = new Map<string, { content: string; stepName: string }>()
  for (const artifact of codeArtifacts) {
    try {
      const raw = await readArtifactContentViaTool(readFile, artifact.path, toolMap.get("run_command"))
      if (typeof raw === "string" && raw.length > 0) {
        fileContents.set(artifact.path, { content: raw, stepName: artifact.stepName })
      }
    } catch { /* skip unreadable files */ }
  }

  if (fileContents.size < 2) return

  const definitions = new Map<string, { file: string; stepName: string; params: number }>()
  const BUILTIN_RE = /^(if|for|while|switch|return|catch|new|typeof|import|require|console|document|window|Math|Array|Object|String|Date|JSON|Promise|setTimeout|setInterval|requestAnimationFrame|parseInt|parseFloat|alert|Error|Map|Set|WeakMap|WeakRef|Symbol|Proxy|Reflect|Number|Boolean|RegExp|Function|eval|isNaN|isFinite|decodeURI|encodeURI|atob|btoa|fetch|Response|Request|URL|URLSearchParams|AbortController|TextEncoder|TextDecoder|Blob|File|FileReader|FormData|crypto|performance|navigator|location|history|screen|localStorage|sessionStorage|indexedDB|Worker|SharedWorker|MessageChannel|MessagePort|BroadcastChannel|EventSource|WebSocket|XMLHttpRequest|IntersectionObserver|MutationObserver|ResizeObserver|Image|Audio|Video|Canvas|CanvasRenderingContext2D|Path2D|createTextNode|createDocumentFragment|querySelectorAll|querySelector|getElementById|getElementsByClassName|getElementsByTagName|createElement|appendChild|removeChild|insertBefore|replaceChild|cloneNode|hasChildNodes|addEventListener|removeEventListener|dispatchEvent|preventDefault|stopPropagation|toString|valueOf|hasOwnProperty|getPrototypeOf|keys|values|entries|assign|freeze|create|defineProperty|getOwnPropertyDescriptor|is|from|isArray|of|resolve|reject|all|allSettled|race|any|then|finally|log|warn|error|info|debug|table|trace|assert|clear|count|dir|group|groupEnd|time|timeEnd|timeLog|startsWith|endsWith|includes|indexOf|lastIndexOf|match|replace|replaceAll|search|split|trim|trimStart|trimEnd|padStart|padEnd|repeat|charAt|charCodeAt|codePointAt|normalize|toUpperCase|toLowerCase|toLocaleUpperCase|toLocaleLowerCase|concat|substring|slice|at|flat|flatMap|fill|find|findIndex|findLast|findLastIndex|every|some|reduce|reduceRight|sort|reverse|splice|unshift|shift|pop|push|map|filter|forEach|join|length|abs|ceil|floor|round|max|min|pow|sqrt|random|sign|trunc|cbrt|log2|log10|exp|sin|cos|tan|asin|acos|atan|atan2|PI|E|stringify|parse|now|getTime|getDate|getMonth|getFullYear|getHours|getMinutes|getSeconds|getMilliseconds|toISOString|toLocaleDateString|toLocaleTimeString|setItem|getItem|removeItem|test|exec|super|this|self|globalThis|undefined|null|NaN|Infinity|true|false|void|delete|instanceof|in|class|extends|static|get|set|async|await|yield|throw|try|break|continue|do|else|export|default|with|debugger|let|var|const|of|arguments)$/

  for (const [filePath, { content, stepName }] of fileContents) {
    const defPatterns = [
      /function\s+(\w+)\s*\(([^)]*)\)/g,
      /(?:const|let|var)\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/g,
      /(?:const|let|var)\s+(\w+)\s*=\s*function\s*\(([^)]*)\)/g,
      /(\w+)\s*\(([^)]*)\)\s*\{/g,
    ]

    for (const pattern of defPatterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1]
        const paramsStr = match[2] ?? ""
        if (!name || name.length < 2) continue
        if (BUILTIN_RE.test(name)) continue
        const paramCount = paramsStr.trim() === "" ? 0 : paramsStr.split(",").length
        if (!definitions.has(name)) {
          definitions.set(name, { file: filePath, stepName, params: paramCount })
        }
      }
    }
  }

  const mismatches: { callerFile: string; callerStep: string; defFile: string; defStep: string; name: string; expectedParams: number; actualArgs: number }[] = []

  for (const [filePath, { content, stepName }] of fileContents) {
    const callRegex = /\b(\w+)\s*\(([^)]*)\)/g
    let match: RegExpExecArray | null
    while ((match = callRegex.exec(content)) !== null) {
      const name = match[1]
      const argsStr = match[2]
      if (!name || name.length < 2) continue
      if (BUILTIN_RE.test(name)) continue

      const def = definitions.get(name)
      if (!def || def.file === filePath) continue

      const argCount = argsStr.trim() === "" ? 0 : argsStr.split(",").length
      if (def.params !== argCount) {
        mismatches.push({
          callerFile: filePath,
          callerStep: stepName,
          defFile: def.file,
          defStep: def.stepName,
          name,
          expectedParams: def.params,
          actualArgs: argCount,
        })
      }
    }
  }

  if (mismatches.length === 0) return

  for (const mm of mismatches) {
    const issue = `Cross-file signature mismatch: "${mm.name}" defined in ${mm.defFile} with ${mm.expectedParams} param(s) but called from ${mm.callerFile} with ${mm.actualArgs} arg(s)`
    const idx = assessments.findIndex(a => a.stepName === mm.callerStep)
    if (idx >= 0) {
      const existing = assessments[idx]
      if (!existing.issues.includes(issue)) {
        assessments[idx] = {
          stepName: existing.stepName,
          outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
          confidence: existing.outcome === "pass" ? 0.3 : existing.confidence,
          issues: [...existing.issues, issue],
          retryable: true,
        }
      }
    }
  }
}

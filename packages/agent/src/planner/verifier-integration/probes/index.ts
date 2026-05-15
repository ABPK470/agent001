import { VerifierOutcome } from "@mia/agent"
/**
 * Integration probe functions for cross-step artifact verification.
 *
 * @module
 */

import { normalizeSpecPath } from "../../blueprint-contract/index.js"
import type { Plan, VerifierStepAssessment } from "../../types.js"
import {
  type IntegrationProbe,
  type IntegrationProbeContext,
  collectIntegrationArtifacts,
  collectReachableRuntimeArtifacts,
  extractDefinedCssClasses,
  extractHtmlScriptRefs,
  extractModuleExports,
  extractModuleImports,
  extractReferencedCssClassesFromHtml,
  extractReferencedCssClassesFromScript,
  findWsRootForStep,
  probeArtifactViaTool,
  readArtifactContentViaTool,
  readIntegrationArtifactContents,
  resolveArtifactImport,
  resolveArtifactReference
} from "../helpers.js"
import { probeCrossFileFunctionSignatures } from "./signatures.js"
import { probeWebEntrypointRuntimeWiring } from "./web-entrypoint.js"

// ── Entry point ──

export async function runIntegrationProbes(
  plan: Plan,
  _pipelineResult: unknown,
  toolMap: Map<string, import("../../../types.js").Tool>,
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

// ── Integration probes ──

// probeWebEntrypointRuntimeWiring lives in probes/web-entrypoint.ts
// probeCrossFileFunctionSignatures lives in probes/signatures.ts

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
        outcome: existing.outcome === VerifierOutcome.Pass ? VerifierOutcome.Retry : existing.outcome,
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
      outcome: existing.outcome === VerifierOutcome.Pass ? VerifierOutcome.Retry : existing.outcome,
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
        outcome: existing.outcome === VerifierOutcome.Pass ? VerifierOutcome.Retry : existing.outcome,
        confidence: existing.outcome === "pass" ? 0.35 : existing.confidence,
        issues: [...existing.issues, ...issues.filter(issue => !existing.issues.includes(issue))],
        retryable: true,
      }
    }
  }
}

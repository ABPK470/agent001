import { VerifierOutcome } from "../../../domain/index.js"
/**
 * Web entry-point runtime wiring probe — checks that HTML artifacts reach
 * their related runtime JS artifacts via <script> / module imports and that
 * referenced script/stylesheet files exist on disk.
 *
 * @module
 */

import { normalizeSpecPath } from "../../blueprint-contract/index.js"
import {
  type IntegrationProbeContext,
  collectReachableRuntimeArtifacts,
  extractHtmlScriptRefs,
  findWsRootForStep,
  probeArtifactViaTool,
  readArtifactContentViaTool,
  readIntegrationArtifactContents
} from "../helpers.js"

export async function probeWebEntrypointRuntimeWiring(ctx: IntegrationProbeContext): Promise<void> {
  const { plan, toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  const htmlArtifacts = allArtifacts.filter((a) => /\.html?$/i.test(a.path))
  const jsArtifacts = allArtifacts.filter((a) => /\.js$/i.test(a.path))
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
    } catch {
      continue
    }

    const htmlDir = htmlEntry.path.replace(/[^/]+$/, "")
    const relatedJs = jsArtifacts.filter((js) => {
      const jsDir = js.path.replace(/[^/]+$/, "")
      return jsDir.startsWith(htmlDir)
    })

    if (relatedJs.length === 0) continue

    const scriptRefs = extractHtmlScriptRefs(htmlContent)
    const relatedJsContent = await readIntegrationArtifactContents(
      relatedJs,
      readFile,
      readArtifactContentViaTool,
      runCommand
    )
    const reachableRuntimeArtifacts = collectReachableRuntimeArtifacts(
      htmlEntry.path,
      scriptRefs,
      relatedJs,
      relatedJsContent
    )

    const missingScripts: string[] = []
    for (const jsEntry of relatedJs) {
      if (!reachableRuntimeArtifacts.has(normalizeSpecPath(jsEntry.path))) {
        const jsBasename = jsEntry.path.split("/").pop() ?? jsEntry.path
        missingScripts.push(jsBasename)
      }
    }

    if (missingScripts.length > 0) {
      const idx = assessments.findIndex((a) => a.stepName === htmlEntry.stepName)
      const issue = `Integration gap: entry artifact "${htmlEntry.path}" does not reach related runtime artifacts through module scripts/imports: ${missingScripts.join(", ")}. Runtime code will never load.`
      if (idx >= 0) {
        const existing = assessments[idx]
        assessments[idx] = {
          stepName: existing.stepName,
          outcome: existing.outcome === VerifierOutcome.Pass ? VerifierOutcome.Retry : existing.outcome,
          confidence: existing.outcome === "pass" ? 0.4 : existing.confidence,
          issues: [...existing.issues, issue],
          retryable: true
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
            `The browser will 404 and the page will be non-functional. Either write the missing file or remove the reference.`
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
            `Styles will be missing. Either write the missing CSS file or remove the reference.`
        )
      }
    }
    if (missingRefIssues.length > 0) {
      const idx = assessments.findIndex((a) => a.stepName === htmlEntry.stepName)
      if (idx >= 0) {
        const existing = assessments[idx]
        assessments[idx] = {
          stepName: existing.stepName,
          outcome: VerifierOutcome.Retry,
          confidence: 0.0,
          issues: [...existing.issues, ...missingRefIssues],
          retryable: true
        }
      }
    }
  }
}

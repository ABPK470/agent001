import { VerifierOutcome } from "@mia/agent"
/**
 * Cross-file function signature probe — detects parameter count mismatches
 * between function definitions and call sites across plan artifacts.
 *
 * @module
 */

import type {
    IntegrationProbeContext,
} from "../helpers.js"
import {
    readArtifactContentViaTool,
} from "../helpers.js"

const BUILTIN_RE = /^(if|for|while|switch|return|catch|new|typeof|import|require|console|document|window|Math|Array|Object|String|Date|JSON|Promise|setTimeout|setInterval|requestAnimationFrame|parseInt|parseFloat|alert|Error|Map|Set|WeakMap|WeakRef|Symbol|Proxy|Reflect|Number|Boolean|RegExp|Function|eval|isNaN|isFinite|decodeURI|encodeURI|atob|btoa|fetch|Response|Request|URL|URLSearchParams|AbortController|TextEncoder|TextDecoder|Blob|File|FileReader|FormData|crypto|performance|navigator|location|history|screen|localStorage|sessionStorage|indexedDB|Worker|SharedWorker|MessageChannel|MessagePort|BroadcastChannel|EventSource|WebSocket|XMLHttpRequest|IntersectionObserver|MutationObserver|ResizeObserver|Image|Audio|Video|Canvas|CanvasRenderingContext2D|Path2D|createTextNode|createDocumentFragment|querySelectorAll|querySelector|getElementById|getElementsByClassName|getElementsByTagName|createElement|appendChild|removeChild|insertBefore|replaceChild|cloneNode|hasChildNodes|addEventListener|removeEventListener|dispatchEvent|preventDefault|stopPropagation|toString|valueOf|hasOwnProperty|getPrototypeOf|keys|values|entries|assign|freeze|create|defineProperty|getOwnPropertyDescriptor|is|from|isArray|of|resolve|reject|all|allSettled|race|any|then|finally|log|warn|error|info|debug|table|trace|assert|clear|count|dir|group|groupEnd|time|timeEnd|timeLog|startsWith|endsWith|includes|indexOf|lastIndexOf|match|replace|replaceAll|search|split|trim|trimStart|trimEnd|padStart|padEnd|repeat|charAt|charCodeAt|codePointAt|normalize|toUpperCase|toLowerCase|toLocaleUpperCase|toLocaleLowerCase|concat|substring|slice|at|flat|flatMap|fill|find|findIndex|findLast|findLastIndex|every|some|reduce|reduceRight|sort|reverse|splice|unshift|shift|pop|push|map|filter|forEach|join|length|abs|ceil|floor|round|max|min|pow|sqrt|random|sign|trunc|cbrt|log2|log10|exp|sin|cos|tan|asin|acos|atan|atan2|PI|E|stringify|parse|now|getTime|getDate|getMonth|getFullYear|getHours|getMinutes|getSeconds|getMilliseconds|toISOString|toLocaleDateString|toLocaleTimeString|setItem|getItem|removeItem|test|exec|super|this|self|globalThis|undefined|null|NaN|Infinity|true|false|void|delete|instanceof|in|class|extends|static|get|set|async|await|yield|throw|try|break|continue|do|else|export|default|with|debugger|let|var|const|of|arguments)$/

export async function probeCrossFileFunctionSignatures(ctx: IntegrationProbeContext): Promise<void> {
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
          outcome: existing.outcome === VerifierOutcome.Pass ? VerifierOutcome.Retry : existing.outcome,
          confidence: existing.outcome === "pass" ? 0.3 : existing.confidence,
          issues: [...existing.issues, issue],
          retryable: true,
        }
      }
    }
  }
}

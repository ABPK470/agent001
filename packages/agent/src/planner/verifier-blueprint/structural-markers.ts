/**
 * Structural marker extraction from blueprint text and source/HTML artifacts.
 *
 * Extracted from core.ts.
 *
 * @module
 */

import { normalizeSpecPath, uniqueStrings } from "../blueprint-contract.js"

function normalizeStructuralMarker(kind: string, value: string): string {
  return `${kind}:${value.trim().toLowerCase()}`
}

function collectRegexMarkers(content: string, kind: string, pattern: RegExp, group = 1): string[] {
  const markers: string[] = []
  for (const match of content.matchAll(pattern)) {
    const value = match[group]
    if (typeof value === "string" && value.trim().length > 0) {
      markers.push(normalizeStructuralMarker(kind, value))
    }
  }
  return markers
}

export const BLUEPRINT_FILE_PATH_RE = /`([^`]*?(?:index\.[A-Za-z0-9]+|[\w./-]+\.(?:[A-Za-z0-9]{1,8})))`/u
export const BLUEPRINT_TREE_FILE_RE = /^[|`'\-+*\\/ ]*([A-Za-z0-9_./-]+\.(?:[A-Za-z0-9]{1,8}))$/u

export function extractStructureMarkersFromText(text: string): string[] {
  const markers: string[] = []

  const snippets = [text, ...(Array.from(text.matchAll(/`([^`]+)`/g), match => match[1]))]
  for (const snippet of snippets) {
    for (const match of snippet.matchAll(/<([a-z][a-z0-9-]*)\b/giu)) {
      markers.push(normalizeStructuralMarker("tag", match[1]))
    }
    for (const match of snippet.matchAll(/(^|\s)#([a-z][\w-]*)/giu)) {
      markers.push(normalizeStructuralMarker("id", match[2]))
    }
    for (const match of snippet.matchAll(/(^|\s)\.([a-z][\w-]*)/giu)) {
      markers.push(normalizeStructuralMarker("class", match[2]))
    }
    for (const match of snippet.matchAll(/\b(data-[a-z0-9-]+)\b/giu)) {
      markers.push(normalizeStructuralMarker("data", match[1]))
    }
    for (const match of snippet.matchAll(/\[\s*(data-[a-z0-9-]+)(?:=[^\]]+)?\]/giu)) {
      markers.push(normalizeStructuralMarker("data", match[1]))
    }
    for (const match of snippet.matchAll(/\b([A-Z][A-Za-z0-9]*(?:Panel|View|Component|Layout|Widget|Page|Dialog|Modal|Card|List|Form|Header|Footer|Sidebar|Board|Canvas|Grid))\b/g)) {
      markers.push(normalizeStructuralMarker("component", match[1]))
    }
    for (const match of snippet.matchAll(/\b(?:function|method|proc(?:edure)?|subroutine|def|fn|lambda|handler|command|cmdlet|label|target)\s+`?([A-Za-z_.$@?-][\w.$@-]*)`?/giu)) {
      markers.push(normalizeStructuralMarker("function", match[1]))
    }
    for (const match of snippet.matchAll(/\b(?:class|struct|interface|trait|enum|record|module|namespace|package|type)\s+`?([A-Za-z_.$@?-][\w.$@-]*)`?/giu)) {
      markers.push(normalizeStructuralMarker("type", match[1]))
    }
  }

  return uniqueStrings(markers)
}

function extractHtmlStructureMarkers(content: string): string[] {
  const markers: string[] = []

  for (const match of content.matchAll(/<([a-z][a-z0-9-]*)\b/giu)) {
    markers.push(normalizeStructuralMarker("tag", match[1]))
  }
  for (const match of content.matchAll(/\sid=["']([^"']+)["']/giu)) {
    markers.push(...match[1].split(/\s+/).filter(Boolean).map(value => normalizeStructuralMarker("id", value)))
  }
  for (const match of content.matchAll(/\sclass=["']([^"']+)["']/giu)) {
    markers.push(...match[1].split(/\s+/).filter(Boolean).map(value => normalizeStructuralMarker("class", value)))
  }
  for (const match of content.matchAll(/\s(data-[a-z0-9-]+)(?:=["'][^"']*["'])?/giu)) {
    markers.push(normalizeStructuralMarker("data", match[1]))
  }
  for (const match of content.matchAll(/<script[^>]+src=["']([^"']+)["']/giu)) {
    markers.push(normalizeStructuralMarker("script", normalizeSpecPath(match[1])))
  }
  for (const match of content.matchAll(/<link[^>]+href=["']([^"']+)["']/giu)) {
    markers.push(normalizeStructuralMarker("asset", normalizeSpecPath(match[1])))
  }

  return uniqueStrings(markers)
}

function extractCodeStructureMarkers(content: string): string[] {
  const markers: string[] = []

  markers.push(...collectRegexMarkers(content, "function", /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*def\s+([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*fn\s+([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:public|private|protected|internal|static|final|virtual|override|abstract|sealed|async|partial|inline|constexpr|synchronized|extern|unsafe|new|shared|friend|mut|pub|open|operator|default|class)?(?:\s+(?:public|private|protected|internal|static|final|virtual|override|abstract|sealed|async|partial|inline|constexpr|synchronized|extern|unsafe|new|shared|friend|mut|pub|open|operator|default))*\s*[A-Za-z_][\w<>,.?\[\]]*\s+([A-Za-z_][\w]*)\s*\([^;\n{}]*\)\s*(?:\{|=>)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\b/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\s*\{/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\b/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*sub\s+([A-Za-z_][\w]*)\b/gi))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*proc(?:edure)?\s+([A-Za-z_][\w]*)\b/gi))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*\.?(?:globl|global)\s+([A-Za-z_.$@?][\w.$@?]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*([A-Za-z_.$@?][\w.$@?]*)\s*:/g))
  markers.push(...collectRegexMarkers(content, "function", /\(defun\s+([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /\(defmacro\s+([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /\(define\s+\(([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:function|filter|workflow)\s+([A-Za-z_][\w-]*)\b/gi))

  markers.push(...collectRegexMarkers(content, "type", /export\s+class\s+([A-Za-z_$][\w$]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*(?:class|struct|interface|trait|enum|record|module|namespace|package)\s+([A-Za-z_][\w.]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*(?:public|private|protected|internal)?\s*(?:abstract\s+|final\s+|sealed\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface|=)/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*New-Alias\s+-Name\s+([A-Za-z_][\w-]*)\b/gi))

  markers.push(...collectRegexMarkers(content, "component", /(?:^|\n)\s*const\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*\([^)]*\)\s*=>\s*</g))
  markers.push(...collectRegexMarkers(content, "component", /(?:^|\n)\s*function\s+([A-Z][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{?[\s\S]{0,120}?return\s*\(/g))
  markers.push(...collectRegexMarkers(content, "component", /<([A-Z][A-Za-z0-9_]*)\b/g))
  markers.push(...collectRegexMarkers(content, "tag", /<([a-z][a-z0-9-]*)\b/g))

  return uniqueStrings(markers)
}

export function detectStructuralMarkersInArtifact(path: string, content: string): string[] {
  if (/\.html?$/i.test(path)) return extractHtmlStructureMarkers(content)
  if (/\.(?:tsx|jsx)$/i.test(path)) return uniqueStrings([...extractHtmlStructureMarkers(content), ...extractCodeStructureMarkers(content)])
  if (/\.(?:ts|js|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|cs|vb|php|rb|swift|scala|sh|bash|zsh|fish|ps1|psm1|psd1|pl|pm|lua|r|jl|clj|cljs|cljc|lisp|el|asm|s|S|c|cc|cpp|cxx|h|hpp|hh)$/i.test(path)) return extractCodeStructureMarkers(content)
  if (/\.(?:xml|xaml|csproj|fsproj|vbproj|gradle|properties|toml|yaml|yml|json|ini|cfg|conf|sql|md|txt)$/i.test(path)) return uniqueStrings([...extractStructureMarkersFromText(content), ...extractCodeStructureMarkers(content)])
  return []
}

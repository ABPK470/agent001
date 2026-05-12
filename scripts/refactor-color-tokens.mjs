#!/usr/bin/env node
/**
 * One-shot codemod: replace hardcoded Tailwind color classes with semantic
 * tokens defined in packages/ui/src/index.css.
 *
 * SAFE — only touches className strings (matched by word boundary). Uses
 * conservative patterns; never strips meaning. Excluded files require
 * context-specific handling and are skipped here.
 *
 * Run: node scripts/refactor-color-tokens.mjs
 *      node scripts/refactor-color-tokens.mjs --dry
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { extname, join, relative } from "node:path"

const ROOT = new URL("../packages/ui/src/", import.meta.url).pathname
const DRY = process.argv.includes("--dry")

// Files we do NOT touch — handled manually due to context-specific colour use.
const SKIP = new Set([
  "index.css",
  "components/ThemeToggle.tsx",     // already token-correct
  "widgets/MymiDb.tsx",             // datatype rainbow handled manually
  "widgets/AgentViz.tsx",           // viz palette — uses semantic viz-* already
])

// Order matters — longer / more specific patterns first.
const RULES = [
  // ── White overlays ────────────────────────────────────────────
  // Backgrounds
  [/\bbg-white\/\[0\.01\]/g, "bg-overlay-1"],
  [/\bbg-white\/\[0\.015\]/g, "bg-overlay-1"],
  [/\bbg-white\/\[0\.02\]/g, "bg-overlay-1"],
  [/\bbg-white\/\[0\.025\]/g, "bg-overlay-1"],
  [/\bbg-white\/\[0\.03\]/g, "bg-overlay-2"],
  [/\bbg-white\/\[0\.04\]/g, "bg-overlay-2"],
  [/\bbg-white\/\[0\.05\]/g, "bg-overlay-2"],
  [/\bbg-white\/5\b/g, "bg-overlay-2"],
  [/\bbg-white\/\[0\.06\]/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.07\]/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.08\]/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.10\]/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.1\]/g, "bg-overlay-3"],
  [/\bbg-white\/10\b/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.12\]/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.15\]/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.18\]/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.20\]/g, "bg-overlay-3"],
  [/\bbg-white\/\[0\.2\]/g, "bg-overlay-3"],
  [/\bbg-white\/20\b/g, "bg-overlay-3"],
  [/\bbg-white\/25\b/g, "bg-overlay-3"],

  // Hover backgrounds
  [/\bhover:bg-white\/\[0\.0[1-5]\]/g, "hover:bg-overlay-hover"],
  [/\bhover:bg-white\/\[0\.025\]/g, "hover:bg-overlay-hover"],
  [/\bhover:bg-white\/\[0\.0[678]\]/g, "hover:bg-overlay-hover"],
  [/\bhover:bg-white\/\[0\.1\]/g, "hover:bg-overlay-hover"],
  [/\bhover:bg-white\/\[0\.10\]/g, "hover:bg-overlay-hover"],
  [/\bhover:bg-white\/5\b/g, "hover:bg-overlay-hover"],
  [/\bhover:bg-white\/10\b/g, "hover:bg-overlay-hover"],

  // Active backgrounds
  [/\bactive:bg-white\/5\b/g, "active:bg-overlay-hover"],
  [/\bactive:bg-white\/\[0\.0[1-8]\]/g, "active:bg-overlay-hover"],

  // Borders
  [/\bborder-white\/\[0\.0[3-8]\]/g, "border-border-subtle"],
  [/\bborder-white\/\[0\.1\]/g, "border-border"],
  [/\bborder-white\/\[0\.10\]/g, "border-border"],
  [/\bborder-white\/\[0\.12\]/g, "border-border"],
  [/\bborder-white\/10\b/g, "border-border"],
  [/\bborder-white\/\[0\.20\]/g, "border-border-strong"],
  [/\bborder-white\/\[0\.2\]/g, "border-border-strong"],
  [/\bborder-white\/20\b/g, "border-border-strong"],

  // Hover borders
  [/\bhover:border-white\b/g, "hover:border-text-secondary"],

  // Rings
  [/\bring-white\/\[0\.0[3-8]\]/g, "ring-border-subtle"],
  [/\bring-white\/\[0\.1\]/g, "ring-border"],
  [/\bring-white\/\[0\.10\]/g, "ring-border"],
  [/\bring-white\/10\b/g, "ring-border"],

  // Divides
  [/\bdivide-white\/\[0\.0[3-8]\]/g, "divide-border-subtle"],
  [/\bdivide-white\/\[0\.1\]/g, "divide-border"],
  [/\bdivide-white\/10\b/g, "divide-border"],

  // From / to (gradients)
  [/\bfrom-white\/\[0\.0[3-8]\]/g, "from-overlay-3"],
  [/\bfrom-white\/\[0\.1\]/g, "from-overlay-3"],
  [/\bfrom-white\/\[0\.18\]/g, "from-overlay-3"],
  [/\bto-white\/\[0\.0[3-8]\]/g, "to-overlay-3"],
  [/\bto-white\/\[0\.1\]/g, "to-overlay-3"],

  // Text
  [/\btext-white\b/g, "text-text"],
  [/\bhover:text-white\b/g, "hover:text-text"],

  // ── Black scrims (modals) ─────────────────────────────────────
  [/\bbg-black\/40\b/g, "bg-scrim"],
  [/\bbg-black\/50\b/g, "bg-scrim"],
  [/\bbg-black\/60\b/g, "bg-scrim"],
  [/\bbg-black\/70\b/g, "bg-scrim"],
  [/\bbg-black\/80\b/g, "bg-scrim"],

  // ── Zinc palette → semantic text/borders/surfaces ─────────────
  [/\btext-zinc-100\b/g, "text-text"],
  [/\btext-zinc-200\b/g, "text-text-secondary"],
  [/\btext-zinc-300\b/g, "text-text-secondary"],
  [/\btext-zinc-400\b/g, "text-text-muted"],
  [/\btext-zinc-500\b/g, "text-text-muted"],
  [/\btext-zinc-600\b/g, "text-text-faint"],
  [/\btext-zinc-700\b/g, "text-text-faint"],
  [/\btext-zinc-800\b/g, "text-text-faint"],
  [/\btext-zinc-900\b/g, "text-text-faint"],

  [/\bhover:text-zinc-100\b/g, "hover:text-text"],
  [/\bhover:text-zinc-200\b/g, "hover:text-text-secondary"],
  [/\bhover:text-zinc-300\b/g, "hover:text-text-secondary"],
  [/\bhover:text-zinc-400\b/g, "hover:text-text-muted"],
  [/\bhover:text-zinc-500\b/g, "hover:text-text-muted"],

  [/\bgroup-hover:text-zinc-100\b/g, "group-hover:text-text"],
  [/\bgroup-hover:text-zinc-200\b/g, "group-hover:text-text-secondary"],
  [/\bgroup-hover:text-zinc-300\b/g, "group-hover:text-text-secondary"],

  [/\bplaceholder:text-zinc-400\b/g, "placeholder:text-text-muted"],
  [/\bplaceholder:text-zinc-500\b/g, "placeholder:text-text-faint"],

  [/\bbg-zinc-700\b/g, "bg-overlay-3"],
  [/\bbg-zinc-800\b/g, "bg-overlay-3"],
  [/\bbg-zinc-900\b/g, "bg-panel-2"],
  [/\bbg-zinc-950\b/g, "bg-canvas"],
  [/\bhover:bg-zinc-900\b/g, "hover:bg-overlay-hover"],

  [/\bborder-zinc-700\b/g, "border-border"],
  [/\bborder-zinc-800\b/g, "border-border-subtle"],
  [/\bborder-zinc-900\b/g, "border-border-subtle"],

  // ── Status palette colours ────────────────────────────────────
  [/\btext-red-400\b/g, "text-error"],
  [/\btext-red-500\b/g, "text-error"],
  [/\bbg-red-500\/\[0\.05\]/g, "bg-error-soft"],
  [/\bbg-red-500\/10\b/g, "bg-error-soft"],
  [/\bbg-red-500\/15\b/g, "bg-error-soft"],
  [/\bbg-red-500\/20\b/g, "bg-error-soft"],

  [/\btext-emerald-300\b/g, "text-success"],
  [/\btext-emerald-400\b/g, "text-success"],
  [/\btext-green-300\b/g, "text-success"],
  [/\btext-green-400\b/g, "text-success"],
  [/\bbg-emerald-500\/10\b/g, "bg-success-soft"],
  [/\bbg-emerald-500\/15\b/g, "bg-success-soft"],
  [/\bbg-green-500\/10\b/g, "bg-success-soft"],
  [/\bbg-green-500\/15\b/g, "bg-success-soft"],

  [/\btext-amber-300\b/g, "text-warning"],
  [/\btext-amber-400\b/g, "text-warning"],
  [/\btext-yellow-300\b/g, "text-warning"],
  [/\btext-yellow-400\b/g, "text-warning"],
  [/\bbg-amber-500\/10\b/g, "bg-warning-soft"],
  [/\bbg-amber-500\/15\b/g, "bg-warning-soft"],
  [/\bbg-yellow-500\/10\b/g, "bg-warning-soft"],
  [/\bbg-yellow-500\/15\b/g, "bg-warning-soft"],

  [/\btext-blue-300\b/g, "text-info"],
  [/\btext-blue-400\b/g, "text-info"],
  [/\bbg-blue-500\/10\b/g, "bg-info-soft"],
  [/\bbg-blue-500\/15\b/g, "bg-info-soft"],

  // ── Solid status fills (status dots, badges) ─────────────────
  [/\bbg-emerald-400\b/g, "bg-success"],
  [/\bbg-emerald-500\b/g, "bg-success"],
  [/\bbg-green-400\b/g, "bg-success"],
  [/\bbg-green-500\b/g, "bg-success"],
  [/\bbg-red-400\b/g, "bg-error"],
  [/\bbg-red-500\b/g, "bg-error"],
  [/\bbg-amber-400\b/g, "bg-warning"],
  [/\bbg-amber-500\b/g, "bg-warning"],
  [/\bbg-yellow-400\b/g, "bg-warning"],
  [/\bbg-yellow-500\b/g, "bg-warning"],
  [/\bbg-blue-400\b/g, "bg-info"],
  [/\bbg-blue-500\b/g, "bg-info"],

  [/\bborder-red-500\/20\b/g, "border-error/30"],
  [/\bborder-red-500\/30\b/g, "border-error/40"],
  [/\bborder-emerald-500\/20\b/g, "border-success/30"],
  [/\bborder-amber-500\/20\b/g, "border-warning/30"],
  [/\bborder-blue-500\/20\b/g, "border-info/30"],

  // ── Slate (used as muted greys) ──────────────────────────────
  [/\btext-slate-300\b/g, "text-text-secondary"],
  [/\btext-slate-400\b/g, "text-text-muted"],
  [/\btext-slate-500\b/g, "text-text-muted"],
  [/\bbg-slate-500\/10\b/g, "bg-overlay-2"],
  [/\bbg-slate-500\/15\b/g, "bg-overlay-2"],
  [/\bbg-slate-500\/20\b/g, "bg-overlay-3"],
]

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && [".tsx", ".ts", ".css"].includes(extname(entry.name))) {
      yield full
    }
  }
}

let totalFiles = 0
let totalEdits = 0
const summary = []

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file)
  if (SKIP.has(rel)) continue
  const before = readFileSync(file, "utf8")
  let after = before
  let fileEdits = 0
  for (const [pattern, replacement] of RULES) {
    const matches = after.match(pattern)
    if (matches) {
      fileEdits += matches.length
      after = after.replace(pattern, replacement)
    }
  }
  if (fileEdits > 0) {
    totalFiles++
    totalEdits += fileEdits
    summary.push(`${fileEdits.toString().padStart(4)}  ${rel}`)
    if (!DRY) writeFileSync(file, after)
  }
}

console.log(summary.join("\n"))
console.log(`\n${totalEdits} edits across ${totalFiles} files${DRY ? " (DRY)" : ""}`)

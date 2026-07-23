/**
 * CodeBlock — formatted code display with language badge, copy button,
 * and basic SQL keyword highlighting.
 *
 * Keep this module lean: tool-trace helpers live in tool-code-display.tsx so
 * importing CodeBlock does not pull DataTable / JsonViewer / shared-types.
 */

import { Check, Copy } from "lucide-react"
import { useMemo, useState } from "react"
import { CODE_THEME } from "./code-theme"
import { SqlHighlight } from "./SqlHighlight"
import { SQL_HIGHLIGHT_MAX_CHARS } from "./sql-highlight"

export { SQL_HIGHLIGHT_MAX_CHARS }

const LANG_LABEL: Record<string, string> = {
  sql: "SQL",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  python: "Python",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  md: "Markdown",
  markdown: "Markdown",
  text: "",
  auto: "",
  "": "",
}

export function CodeBlock({
  code,
  lang = "text",
  maxHeight = 256,
}: {
  code: string
  lang?: string
  maxHeight?: number
}) {
  const [copied, setCopied] = useState(false)
  const label = LANG_LABEL[lang] ?? lang.toUpperCase()
  const highlightSql = lang === "sql" && code.length <= SQL_HIGHLIGHT_MAX_CHARS
  const body = useMemo(
    () => (highlightSql ? <SqlHighlight code={code} /> : code),
    [code, highlightSql],
  )

  function copy() {
    navigator.clipboard.writeText(code).catch((err: unknown) => { console.error("[mia]", err) })
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${CODE_THEME.border}` }}>
      <div
        className="flex items-center justify-between px-3 py-1"
        style={{ borderBottom: `1px solid ${CODE_THEME.border}` }}
      >
        <span
          className="text-xs font-mono uppercase tracking-widest"
          style={{ color: CODE_THEME.dim }}
        >
          {label || "code"}
        </span>
        <button
          type="button"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs cursor-pointer transition-colors hover:bg-overlay-2"
          style={{ color: copied ? CODE_THEME.success : CODE_THEME.dim }}
          onClick={copy}
          title="Copy to clipboard"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre
        className="code-pre px-3 py-2.5 overflow-auto whitespace-pre-wrap break-all"
        style={{ maxHeight }}
      >
        {body}
      </pre>
    </div>
  )
}

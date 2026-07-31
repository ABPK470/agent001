/**
 * CodeBlock — one surface for code: perimeter + toolbar divider + body.
 * Never nest inside another bordered frame — pass this as the surface.
 * Chat answer fences and tool/sync output share this chrome (icon + Copy).
 */

import { Check, Copy } from "lucide-react"
import { useMemo, useState } from "react"
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
  toolbar = true,
  embedded = false,
  label: labelProp,
  className,
}: {
  code: string
  lang?: string
  maxHeight?: number
  /** Language badge + Copy row. Set false when the parent supplies chrome. */
  toolbar?: boolean
  /**
   * Nested inside a parent that already owns the surface perimeter.
   * Drops border/radius — only toolbar divider + body remain.
   */
  embedded?: boolean
  /** Override the toolbar label (e.g. sync meta). Skips lang uppercasing. */
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const langLabel = LANG_LABEL[lang] ?? lang.toUpperCase()
  const label = labelProp ?? (langLabel || "code")
  const labelClass = labelProp
    ? "mia-code-block__label mia-code-block__label--custom"
    : "mia-code-block__label"
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
    <div
      className={[
        "mia-code-block",
        embedded ? "mia-code-block--embedded" : null,
        className,
      ].filter(Boolean).join(" ")}
    >
      {toolbar ? (
        <div className="mia-code-block__toolbar">
          <span className={labelClass}>{label}</span>
          <button
            type="button"
            className="mia-code-block__copy"
            data-copied={copied || undefined}
            onClick={copy}
            title="Copy to clipboard"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      ) : null}
      <pre className="mia-code-block__body code-pre" style={{ maxHeight }}>
        {body}
      </pre>
    </div>
  )
}

/**
 * CodeBlock — formatted code display with language badge, copy button,
 * and basic SQL keyword highlighting.
 *
 * Also exports `extractToolCode` — extracts the primary code artifact from tool
 * call arguments so callers can display SQL queries, shell commands, and file
 * contents in a readable block rather than raw escaped JSON.
 */

import { Check, Copy } from "lucide-react"
import { useState, type ReactNode } from "react"
import { C } from "../widgets/ioe/constants"

// ── SQL keyword set ──────────────────────────────────────────────

const SQL_KW = new Set(
  (
    "SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER CROSS FULL ON AND OR NOT " +
    "GROUP BY ORDER HAVING WITH AS UNION ALL DISTINCT TOP COUNT SUM MIN MAX AVG " +
    "CASE WHEN THEN ELSE END IN LIKE BETWEEN NULL IS EXISTS INSERT INTO UPDATE DELETE " +
    "SET VALUES CREATE ALTER DROP TABLE VIEW INDEX ASC DESC CAST CONVERT COALESCE " +
    "ISNULL IIF OVER PARTITION ROW_NUMBER RANK DENSE_RANK NTILE " +
    "NOLOCK READPAST UPDLOCK ROWLOCK TABLOCK TABLOCKX " +
    "OBJECT_SCHEMA_NAME OBJECT_NAME DB_ID OBJECT_ID SCHEMA_NAME " +
    "TYPE_NAME DATABASEPROPERTYEX SERVERPROPERTY " +
    "PRIMARY KEY FOREIGN REFERENCES CONSTRAINT DEFAULT CHECK UNIQUE " +
    "BEGIN END COMMIT ROLLBACK TRANSACTION EXEC EXECUTE RETURN " +
    "DECLARE PRINT IF ELSE WHILE BREAK CONTINUE GOTO " +
    "WITH NOCHECK OPTION RECOMPILE MAXDOP"
  ).split(" "),
)

// ── SQL tokeniser ────────────────────────────────────────────────

type SqlToken = { k: "kw" | "str" | "cmt" | "num" | "plain"; t: string }

/**
 * Split a SQL string into typed tokens using a single-pass regex.
 * Priority order: string literals → line comments → block comments →
 *   numbers → identifier/keyword → everything else (punctuation, whitespace).
 */
function tokenizeSql(sql: string): SqlToken[] {
  const re =
    /('(?:[^'\\]|\\.)*'|'')|(--.*)|(\/\*[\s\S]*?\*\/)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|([^\w]+)/g
  const toks: SqlToken[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    if (m[1] !== undefined) toks.push({ k: "str",   t: m[1] })
    else if (m[2] !== undefined) toks.push({ k: "cmt",  t: m[2] })
    else if (m[3] !== undefined) toks.push({ k: "cmt",  t: m[3] })
    else if (m[4] !== undefined) toks.push({ k: "num",  t: m[4] })
    else if (m[5] !== undefined) toks.push({ k: SQL_KW.has(m[5].toUpperCase()) ? "kw" : "plain", t: m[5] })
    else if (m[6] !== undefined) toks.push({ k: "plain", t: m[6] })
  }
  return toks
}

function SqlHighlight({ code }: { code: string }) {
  const toks = tokenizeSql(code)
  const els: ReactNode[] = toks.map((tok, i) => {
    if (tok.k === "kw")  return <span key={i} style={{ color: C.accent }}>{tok.t}</span>
    if (tok.k === "str") return <span key={i} style={{ color: C.success }}>{tok.t}</span>
    if (tok.k === "cmt") return <span key={i} style={{ color: C.dim, fontStyle: "italic" }}>{tok.t}</span>
    if (tok.k === "num") return <span key={i} style={{ color: C.peach }}>{tok.t}</span>
    return <span key={i} style={{ color: C.textSecondary }}>{tok.t}</span>
  })
  return <>{els}</>
}

// ── Language label map ───────────────────────────────────────────

const LANG_LABEL: Record<string, string> = {
  sql:        "SQL",
  sh:         "Shell",
  bash:       "Shell",
  zsh:        "Shell",
  js:         "JavaScript",
  jsx:        "JSX",
  ts:         "TypeScript",
  tsx:        "TSX",
  python:     "Python",
  json:       "JSON",
  html:       "HTML",
  css:        "CSS",
  scss:       "SCSS",
  md:         "Markdown",
  markdown:   "Markdown",
  text:       "",
  auto:       "",
  "":         "",
}

// ── CodeBlock component ──────────────────────────────────────────

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

  function copy() {
    navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3 py-1"
        style={{ background: C.elevated, borderBottom: `1px solid ${C.border}` }}
      >
        <span
          className="text-[11px] font-mono uppercase tracking-widest"
          style={{ color: C.dim }}
        >
          {label || "code"}
        </span>
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] cursor-pointer transition-colors hover:bg-white/5"
          style={{ color: copied ? C.success : C.dim }}
          onClick={copy}
          title="Copy to clipboard"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {/* Code body */}
      <pre
        className="text-[12.5px] font-mono leading-relaxed px-3 py-2.5 overflow-auto"
        style={{
          background: C.base,
          color: C.textSecondary,
          maxHeight,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {lang === "sql" ? <SqlHighlight code={code} /> : code}
      </pre>
    </div>
  )
}

// ── Tool arg extraction ──────────────────────────────────────────

/** Which field in each tool's input holds the "main code" artifact. */
const TOOL_CODE_FIELDS: Record<string, { field: string; lang: string }> = {
  query_mssql:     { field: "query",       lang: "sql" },
  run_command:     { field: "command",     lang: "sh"  },
  write_file:      { field: "content",     lang: "auto" },
  append_file:     { field: "content",     lang: "auto" },
  replace_in_file: { field: "new_content", lang: "auto" },
  // fetch_url has url but that's not code, skip intentionally
}

function guessLangFromPath(path: string): string {
  const ext = (path ?? "").split(".").pop()?.toLowerCase() ?? ""
  const MAP: Record<string, string> = {
    ts: "ts", tsx: "ts", js: "js", jsx: "js", mjs: "js",
    sql: "sql", py: "python", sh: "sh", bash: "sh", zsh: "sh",
    json: "json", html: "html", css: "css", scss: "scss", md: "markdown",
  }
  return MAP[ext] ?? "text"
}

/**
 * Extract the primary code artifact from tool call arguments.
 * Accepts either a parsed args object (as used in StepTimeline step.input)
 * or a JSON string (as used in TraceEntry.argsFormatted from the IOE trace).
 *
 * Returns null when the tool doesn't produce displayable code, or when there
 * is no non-empty string value in the expected field.
 */
export function extractToolCode(
  toolName: string,
  args: Record<string, unknown> | string,
): { code: string; lang: string; field: string } | null {
  const parsed: Record<string, unknown> | null =
    typeof args === "string"
      ? (() => { try { return JSON.parse(args) as Record<string, unknown> } catch { return null } })()
      : args

  if (!parsed) return null

  const spec = TOOL_CODE_FIELDS[toolName]
  if (!spec) return null

  const code = parsed[spec.field]
  if (typeof code !== "string" || !code.trim()) return null

  const lang =
    spec.lang === "auto"
      ? guessLangFromPath(
          (parsed.path as string | undefined) ??
          (parsed.file_path as string | undefined) ??
          "",
        )
      : spec.lang

  return { code, lang, field: spec.field }
}

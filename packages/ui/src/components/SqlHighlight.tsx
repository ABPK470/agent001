import { useMemo, type ReactNode } from "react"
import { CODE_THEME } from "./code-theme"
import { SQL_HIGHLIGHT_MAX_CHARS, tokenizeSql, type SqlToken } from "./sql-highlight"

/** T-SQL syntax coloring — memoized token spans. */
export function SqlHighlight({ code }: { code: string }) {
  const els = useMemo((): ReactNode => {
    if (code.length > SQL_HIGHLIGHT_MAX_CHARS) return code

    const toks = tokenizeSql(code)
    return toks.map((tok: SqlToken, i: number): ReactNode => {
      if (tok.k === "kw") return <span key={i} style={{ color: CODE_THEME.accent }}>{tok.t}</span>
      if (tok.k === "str") return <span key={i} style={{ color: CODE_THEME.success }}>{tok.t}</span>
      if (tok.k === "cmt") return <span key={i} style={{ color: CODE_THEME.dim, fontStyle: "italic" }}>{tok.t}</span>
      if (tok.k === "num") return <span key={i} style={{ color: CODE_THEME.peach }}>{tok.t}</span>
      return <span key={i} style={{ color: CODE_THEME.textSecondary }}>{tok.t}</span>
    })
  }, [code])

  return <>{els}</>
}

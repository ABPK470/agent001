/**
 * T-SQL syntax highlighting tokens — shared by CodeBlock and tests.
 *
 * Handles: 'string' with '' escapes, [bracket] identifiers, line and block comments.
 * Keywords: core words always (case-insensitive); function names only when ALL CAPS
 * so `c.object_id` stays plain while `OBJECT_SCHEMA_NAME` can highlight.
 */

export type SqlTokenKind = "kw" | "str" | "cmt" | "num" | "ident" | "plain"

export type SqlToken = { k: SqlTokenKind; t: string }

const CORE_SQL_KW = new Set(
  (
    "SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER CROSS FULL ON AND OR NOT " +
    "GROUP BY ORDER HAVING WITH AS UNION ALL DISTINCT TOP COUNT SUM MIN MAX AVG " +
    "CASE WHEN THEN ELSE END IN LIKE BETWEEN NULL IS EXISTS INSERT INTO UPDATE DELETE " +
    "SET VALUES CREATE ALTER DROP TABLE VIEW INDEX ASC DESC " +
    "PRIMARY KEY FOREIGN REFERENCES CONSTRAINT DEFAULT CHECK UNIQUE " +
    "BEGIN COMMIT ROLLBACK TRANSACTION EXEC EXECUTE RETURN " +
    "DECLARE PRINT IF WHILE BREAK CONTINUE GOTO " +
    "NOCHECK OPTION RECOMPILE MAXDOP NOLOCK READPAST UPDLOCK ROWLOCK TABLOCK TABLOCKX"
  ).split(" ").filter(Boolean),
)

/** Highlight only when written in uppercase (built-ins / functions). */
const UPPER_ONLY_SQL_KW = new Set(
  (
    "CAST CONVERT COALESCE ISNULL IIF OVER PARTITION ROW_NUMBER RANK DENSE_RANK NTILE " +
    "OBJECT_SCHEMA_NAME OBJECT_NAME DB_ID OBJECT_ID SCHEMA_NAME TYPE_NAME " +
    "DATABASEPROPERTYEX SERVERPROPERTY LOWER UPPER SUBSTRING CHARINDEX"
  ).split(" ").filter(Boolean),
)

function isSqlKeyword(token: string): boolean {
  const upper = token.toUpperCase()
  if (CORE_SQL_KW.has(upper)) return true
  if (UPPER_ONLY_SQL_KW.has(upper) && token === upper) return true
  return false
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_@#]/.test(ch)
}

function isIdentPart(ch: string): boolean {
  return /[\w$#]/.test(ch)
}

function readLineComment(sql: string, i: number): { text: string; next: number } {
  let j = i + 2
  while (j < sql.length && sql[j] !== "\n" && sql[j] !== "\r") j++
  return { text: sql.slice(i, j), next: j }
}

function readBlockComment(sql: string, i: number): { text: string; next: number } {
  const end = sql.indexOf("*/", i + 2)
  if (end === -1) return { text: sql.slice(i), next: sql.length }
  return { text: sql.slice(i, end + 2), next: end + 2 }
}

function readString(sql: string, i: number): { text: string; next: number } {
  let j = i + 1
  while (j < sql.length) {
    if (sql[j] === "'") {
      if (sql[j + 1] === "'") {
        j += 2
        continue
      }
      j++
      break
    }
    j++
  }
  return { text: sql.slice(i, j), next: j }
}

function readBracketIdent(sql: string, i: number): { text: string; next: number } {
  let j = i + 1
  while (j < sql.length) {
    if (sql[j] === "]") {
      j++
      if (sql[j] === "]") j++
      else break
    } else {
      j++
    }
  }
  return { text: sql.slice(i, j), next: j }
}

function readNumber(sql: string, i: number): { text: string; next: number } {
  let j = i
  while (j < sql.length && /[\d.]/.test(sql[j]!)) j++
  return { text: sql.slice(i, j), next: j }
}

function readIdent(sql: string, i: number): { text: string; next: number } {
  let j = i
  while (j < sql.length && isIdentPart(sql[j]!)) j++
  return { text: sql.slice(i, j), next: j }
}

/** Tokenise T-SQL for syntax highlighting. */
export function tokenizeSql(sql: string): SqlToken[] {
  const toks: SqlToken[] = []
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]!

    if (ch === "-" && sql[i + 1] === "-") {
      const { text, next } = readLineComment(sql, i)
      toks.push({ k: "cmt", t: text })
      i = next
      continue
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const { text, next } = readBlockComment(sql, i)
      toks.push({ k: "cmt", t: text })
      i = next
      continue
    }
    if (ch === "'") {
      const { text, next } = readString(sql, i)
      toks.push({ k: "str", t: text })
      i = next
      continue
    }
    if (ch === "[") {
      const { text, next } = readBracketIdent(sql, i)
      toks.push({ k: "ident", t: text })
      i = next
      continue
    }
    if (/\d/.test(ch)) {
      const { text, next } = readNumber(sql, i)
      toks.push({ k: "num", t: text })
      i = next
      continue
    }
    if (isIdentStart(ch)) {
      const { text, next } = readIdent(sql, i)
      toks.push({ k: isSqlKeyword(text) ? "kw" : "ident", t: text })
      i = next
      continue
    }

    let j = i + 1
    while (j < sql.length) {
      const c = sql[j]!
      if (
        c === "'" ||
        c === "[" ||
        c === "-" && sql[j + 1] === "-" ||
        c === "/" && sql[j + 1] === "*" ||
        /\d/.test(c) ||
        isIdentStart(c)
      ) {
        break
      }
      j++
    }
    toks.push({ k: "plain", t: sql.slice(i, j) })
    i = j
  }

  return toks
}

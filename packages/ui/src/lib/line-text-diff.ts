/**
 * Line-oriented LCS diff for pretty-printed JSON / text blocks.
 */

export type LineDiffKind = "same" | "added" | "removed"

export type LineDiffRow = {
  kind: LineDiffKind
  text: string
  oldLine: number | null
  newLine: number | null
}

const MAX_LINES = 4_000

export function buildLineTextDiff(oldText: string, newText: string): LineDiffRow[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    return [
      ...oldLines.map((text, index) => ({
        kind: "removed" as const,
        text,
        oldLine: index + 1,
        newLine: null,
      })),
      ...newLines.map((text, index) => ({
        kind: "added" as const,
        text,
        oldLine: null,
        newLine: index + 1,
      })),
    ]
  }

  const ops = diffLinesLcs(oldLines, newLines)
  const rows: LineDiffRow[] = []
  let oldLine = 1
  let newLine = 1
  for (const op of ops) {
    if (op.type === "equal") {
      rows.push({ kind: "same", text: op.value, oldLine, newLine })
      oldLine++
      newLine++
    } else if (op.type === "delete") {
      rows.push({ kind: "removed", text: op.value, oldLine, newLine: null })
      oldLine++
    } else {
      rows.push({ kind: "added", text: op.value, oldLine: null, newLine })
      newLine++
    }
  }
  return rows
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  return text.replace(/\r\n/g, "\n").split("\n")
}

type LineOp =
  | { type: "equal"; value: string }
  | { type: "delete"; value: string }
  | { type: "insert"; value: string }

function diffLinesLcs(a: string[], b: string[]): LineOp[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j]
        ? 1 + dp[i + 1]![j + 1]!
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const ops: LineOp[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ type: "equal", value: a[i]! })
      i++
      j++
    } else if (j < m && (i === n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      ops.push({ type: "insert", value: b[j]! })
      j++
    } else {
      ops.push({ type: "delete", value: a[i]! })
      i++
    }
  }
  return ops
}

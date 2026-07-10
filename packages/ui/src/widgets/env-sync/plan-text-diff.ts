export type DiffHighlightSegment = {
  kind: "same" | "removed" | "added"
  text: string
}

export type InlineTextDiff = {
  old: DiffHighlightSegment[]
  new: DiffHighlightSegment[]
}

const MAX_DIFF_CHARS = 50_000

/** Word/whitespace token LCS diff for inline code-diff style highlighting. */
export function buildInlineTextDiff(oldText: string, newText: string): InlineTextDiff {
  if (oldText === newText) {
    return {
      old: [{ kind: "same", text: oldText }],
      new: [{ kind: "same", text: newText }],
    }
  }
  if (oldText.length > MAX_DIFF_CHARS || newText.length > MAX_DIFF_CHARS) {
    return {
      old: [{ kind: "removed", text: oldText }],
      new: [{ kind: "added", text: newText }],
    }
  }

  const oldTokens = tokenizeForDiff(oldText)
  const newTokens = tokenizeForDiff(newText)
  const ops = diffTokensLcs(oldTokens, newTokens)

  const oldSegments: DiffHighlightSegment[] = []
  const newSegments: DiffHighlightSegment[] = []
  for (const op of ops) {
    if (op.type === "equal") {
      pushSegment(oldSegments, "same", op.value)
      pushSegment(newSegments, "same", op.value)
    } else if (op.type === "delete") {
      pushSegment(oldSegments, "removed", op.value)
    } else {
      pushSegment(newSegments, "added", op.value)
    }
  }
  return { old: oldSegments, new: newSegments }
}

function tokenizeForDiff(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? (text.length > 0 ? [text] : [])
}

type DiffTokenOp =
  | { type: "equal"; value: string }
  | { type: "delete"; value: string }
  | { type: "insert"; value: string }

function diffTokensLcs(a: string[], b: string[]): DiffTokenOp[] {
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

  const ops: DiffTokenOp[] = []
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

function pushSegment(
  list: DiffHighlightSegment[],
  kind: DiffHighlightSegment["kind"],
  text: string,
): void {
  const last = list[list.length - 1]
  if (last && last.kind === kind) {
    last.text += text
    return
  }
  list.push({ kind, text })
}

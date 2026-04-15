/**
 * Write integrity checks — detect LLM degeneration, corruption, and regression.
 *
 * These helpers run BEFORE committing file writes to catch:
 *   - Gibberish / non-code output
 *   - Truncation (unclosed braces)
 *   - Control character corruption (bad Unicode escapes)
 *   - Function/class loss (regression detection)
 *   - HTML attribute corruption
 *
 * @module
 */

// ── Definition name extraction (for regression detection) ────────

/**
 * Extract function, class, and named constant definitions from source code.
 * Used to detect when a rewrite drops existing definitions that other code depends on.
 */
export function extractDefinedNames(code: string): Set<string> {
  const names = new Set<string>()
  // function declarations: function name(
  for (const m of code.matchAll(/\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g)) {
    if (m[1]) names.add(m[1])
  }
  // class declarations: class Name
  for (const m of code.matchAll(/\bclass\s+([a-zA-Z_$][\w$]*)/g)) {
    if (m[1]) names.add(m[1])
  }
  // const/let/var with function value: const name = function | const name = (
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:function|\(|[a-zA-Z_$][\w$]*\s*=>)/g)) {
    if (m[1]) names.add(m[1])
  }
  return names
}

// ── Write integrity check ────────────────────────────────────────

/**
 * Check written content for LLM degeneration / corruption patterns.
 * Returns a list of warnings (empty = content is OK).
 */
export function checkWriteIntegrity(filePath: string, content: string): string[] {
  const warnings: string[] = []
  if (content.length < 50) return warnings

  const isCode = /\.(js|jsx|ts|tsx|py|rb|java|cs|go|rs|c|cpp|swift|kt|php|sh|bash|zsh)$/i.test(filePath)
  const isHtml = /\.html?$/i.test(filePath)

  if (isCode) {    // ── Pure gibberish detection ──
    // Catches LLM degeneration that produces entirely non-code text,
    // e.g. "[compacted \u0001 full COMPL'd PROMO].THISs''." or
    //      "UPDATE! OFFCHAIN FINAL SCRIPT! INSERT_GAME_PATCH"
    // These lack ANY valid programming keywords.
    const CODE_KEYWORD_RE = /\b(?:function|const|let|var|class|if|else|for|while|do|switch|case|return|import|export|require|module|try|catch|throw|new|this|typeof|instanceof|null|undefined|true|false|async|await|yield|=>|console|document|window)\b/
    if (!CODE_KEYWORD_RE.test(content)) {
      warnings.push(
        `GIBBERISH REJECTED: File contains NO valid code keywords — this is degenerated LLM output, not code. ` +
        `Do NOT write non-code text to code files. Use the think tool to plan, then write REAL code.`
      )
      return warnings // Early return — no point checking further
    }
    // Detect code-mixed-with-gibberish: closing brace/paren followed by a
    // trailing plain-language phrase (no typical code punctuation afterward).
    // This avoids false positives for valid lines like:
    //   if (!piece) throw new Error(`No piece at ${from}`);
    const brokenCodeRe = /[})\]][\s]*[a-z]{3,}(?:\s+[a-z]{3,}){2,}\s*$/i
    const lines = content.split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length > 10 && brokenCodeRe.test(trimmed) &&
          !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("#")) {
        warnings.push(`Line contains gibberish mixed with code: "${trimmed.slice(0, 80)}"`)
        break
      }
    }

    // Detect unclosed braces (truncated/degenerated output)
    const opens = (content.match(/{/g) ?? []).length
    const closes = (content.match(/}/g) ?? []).length
    if (opens > closes + 2) {
      warnings.push(`${opens - closes} unclosed brace(s) — file appears truncated or corrupted`)
    }

    // Detect abrupt ending with non-code text
    const lastLine = lines.filter(l => l.trim().length > 0).pop()?.trim() ?? ""
    if (lastLine.length > 10 &&
        !/[});\]`'"\\]$/.test(lastLine) &&
        !/^(?:export|module\.exports|\/\/|#|\*)/i.test(lastLine) &&
        /[a-z]{3,}\s+[a-z]{3,}/i.test(lastLine)) {
      warnings.push(`File ends with non-code text: "${lastLine.slice(-60)}"`)
    }
  }

  if (isCode || isHtml) {
    // ── Control character detection (Unicode symbol corruption) ──
    // LLMs sometimes generate wrong \u escapes in write_file JSON calls — e.g.
    // \u00010 instead of \u2654 for ♔. Node's JSON parser expands \u0001 to
    // the SOH control byte (0x01) and leaves the trailing '0' as a literal,
    // producing invisible/garbled characters in the browser. Catch this at
    // write-time so the agent can fix it immediately instead of silently
    // committing a corrupted file that defeats the whole repair cycle.
    // eslint-disable-next-line no-control-regex
    if (/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(content)) {
      const m = /[\x01-\x08\x0b\x0c\x0e-\x1f]/.exec(content)
      const pos = m ? m.index : 0
      const ctx = content
        .substring(Math.max(0, pos - 15), pos + 20)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
      warnings.push(
        `CORRUPTED_UNICODE: File contains non-printable control character(s) near: "${ctx}". ` +
        `This happens when a \\u JSON escape is wrong — e.g. \\u0001 instead of \\u2654 for ♔. ` +
        `Use the correct 4-hex-digit \\uXXXX escape or embed the literal character. ` +
        `Chess symbols: \\u2654=♔ \\u2655=♕ \\u2656=♖ \\u2657=♗ \\u2658=♘ \\u2659=♙ ` +
        `\\u265a=♚ \\u265b=♛ \\u265c=♜ \\u265d=♝ \\u265e=♞ \\u265f=♟`
      )
    }
  }

  if (isHtml) {
    // Detect unclosed attribute values
    const unclosedAttrRe = /\w+="[^"]{10,}(?:>|\n|$)/gm
    const unclosed = content.match(unclosedAttrRe)
    if (unclosed && unclosed.length > 0) {
      warnings.push(`Unclosed HTML attribute value: "${unclosed[0].trim().slice(0, 60)}"`)
    }

    // Detect attributes with code garbage
    const corruptAttrRe = /(?!style=)\w+="[^"]*[{};][^"]*"/g
    const corrupt = content.match(corruptAttrRe)
    if (corrupt && corrupt.length > 0) {
      warnings.push(`HTML attribute contains code garbage: "${corrupt[0].slice(0, 60)}"`)
    }
  }

  return warnings
}

/** Structural integrity issues must block writes to keep file state monotonic. */
export function hasStructuralIntegrityIssue(warnings: readonly string[]): boolean {
  return warnings.some(w =>
    /unclosed brace|gibberish|truncated|non-code text|FUNCTION LOSS|Unclosed HTML attribute|code garbage|CORRUPTED_UNICODE/i.test(w),
  )
}

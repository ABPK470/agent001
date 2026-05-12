/**
 * Placeholder/stub regex patterns. Extracted from code-quality.ts.
 *
 * @module
 */

export const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Explicit stubs — keyword can appear ANYWHERE in the comment, not just at the start.
  // LLMs write "// Basic legal move logic placeholder" or "// Handle X (placeholder for now)".
  // Keep this strict to avoid false positives on normal comments like
  // "Implementation details" that describe real code.
  { re: /\/\/.*\b(?:placeholder|todo|fixme|stub|tbd)\b/gi, label: "placeholder comment" },
  { re: /\/\*[^*]*\b(?:placeholder|todo|fixme|stub|tbd)\b/gi, label: "placeholder comment" },
  { re: /#.*\b(?:placeholder|todo|fixme|stub|tbd)\b/gi, label: "placeholder comment" },
  // "TO BE IMPLEMENTED" / "TO BE ADDED" / "NOT YET IMPLEMENTED" deferred stubs
  { re: /\/\/\s*(?:\w+\s+)*(?:to\s+be\s+implemented|to\s+be\s+added|not\s+yet\s+implemented)\b/gi, label: "stub comment" },
  // LLM degeneration: references "existing" code instead of writing it
  // Catches: "// Other code as per existing logic", "// existing implementation",
  // "// rest of the code here", "// same as above", "// code continues as before", "// ... remaining"
  { re: /\/\/\s*(?:other|rest\s+of(?:\s+the)?|remaining)\s+(?:code|logic|implementation)\b/gi, label: "degeneration comment (references code that should be written)" },
  { re: /\/\/\s*(?:existing|previous|prior)\s+(?:code|logic|implementation)\b/gi, label: "degeneration comment (references code that should be written)" },
  { re: /\/\/\s*(?:same|similar|code continues?)\s+(?:as\s+)?(?:above|before|previously|existing)\b/gi, label: "degeneration comment (references code that should be written)" },
  { re: /\/\/\s*(?:as\s+per|as\s+in)\s+(?:existing|previous|above|the\s+original)\b/gi, label: "degeneration comment (references code that should be written)" },
  { re: /\/\/\s*\.{3}\s*(?:remaining|rest|other|more)\b/gi, label: "degeneration comment (elided code)" },
  { re: /\/\/\s*add(?:\s+more)?\s+.*\b(?:logic|handling|implementation|checks?)\s+here\b/gi, label: "placeholder comment (asks to add logic later)" },
  { re: /\/\/\s*for\s+now\b.*\b(?:assume|always|return)\b/gi, label: "deferred-work comment (temporary behavior)" },
  // Trivially-returning validation functions — both `function` declarations AND class methods
  {
    re: /function\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+)\s*\([^)]*\)\s*\{[\s\n]*return\s+(true|false)\s*;?\s*\}/gi,
    label: "validation function always returns constant",
  },
  // Class method variant: `isLegalMove(...) { return true; }` (no `function` keyword)
  {
    re: /^\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+|get\w+Legal\w*|on\w+)\s*\([^)]*\)\s*\{[\s\n]*return\s+(true|false)\s*;?\s*\}/gim,
    label: "stub method always returns constant",
  },
  // Validation/compute functions with a comment then trivial return
  {
    re: /function\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+|get\w+)\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*|\/\*[^*]*\*\/[\s\n]*)+return\s+(true|false|\[\]|\{\}|null|undefined|0|"")\s*;?\s*\}/gi,
    label: "stub function (comment + trivial return)",
  },
  // Class method with comment then trivial return: `isLegalMove(...) { // placeholder\n return true; }`
  {
    re: /^\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+|get\w+|on\w+|handle\w+)\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*|\/\*[^*]*\*\/[\s\n]*)+return\s+(true|false|\[\]|\{\}|null|undefined|0|"")\s*;?\s*\}/gim,
    label: "stub method (comment + trivial return)",
  },
  // Named function with a comment then returning a STRING LITERAL (e.g. return 'ongoing')
  // This catches checkGameStatus() { // comment \n return 'ongoing'; }
  {
    re: /function\s+(check\w*|get\w+Status\w*|get\w+State\w*|calculate\w*|compute\w*|determine\w*)\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*|\/\*[^*]*\*\/[\s\n]*)+return\s+['"][^'"]{1,30}['"]\s*;?\s*\}/gi,
    label: "stub function (comment + hardcoded string return)",
  },
  // Functions whose ENTIRE body is `/* comment */ return [];` or `return {};`
  {
    re: /function\s+\w+\s*\([^)]*\)\s*\{[\s\n]*(?:\/\*[^*]*\*\/[\s\n]*|\/\/[^\n]*[\s\n]*)*(return\s+\[\]\s*;?)\s*\}/gi,
    label: "stub function returns empty array",
  },
  {
    re: /function\s+\w+\s*\([^)]*\)\s*\{[\s\n]*(?:\/\*[^*]*\*\/[\s\n]*|\/\/[^\n]*[\s\n]*)*(return\s+\{\}\s*;?)\s*\}/gi,
    label: "stub function returns empty object",
  },
  // Arrow function variant
  {
    re: /(?:const|let|var)\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+)\s*=\s*\([^)]*\)\s*=>\s*(true|false)\s*;?/gi,
    label: "validation function always returns constant",
  },
  // Arrow function returning empty array/object stub
  {
    re: /(?:const|let|var)\s+\w+\s*=\s*\([^)]*\)\s*=>\s*(\[\]|\{\})\s*;?/gi,
    label: "arrow function returns empty array/object stub",
  },
  // Console.log-only function — a function/method whose only non-comment statement is console.log()
  // This is a de facto stub event handler: `onSquareClick(row, col) { console.log(...); }`
  // Negative lookahead excludes JS keywords (if, for, while, etc.) to prevent false positives.
  {
    re: /(?:function\s+\w+|^\s+(?!if\b|for\b|while\b|switch\b|do\b|catch\b|else\b|return\b|throw\b|new\b|typeof\b|try\b|class\b|const\b|let\b|var\b)\w+)\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*)*console\.log\([^)]*\)\s*;?[\s\n]*\}/gim,
    label: "console.log-only function (stub event handler)",
  },
  // Empty function bodies — both declarations and class methods
  {
    re: /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:function|\([^)]*\)\s*=>))\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*)*\}/gi,
    label: "empty function body",
  },
  // Class method empty body: `  methodName(...) { }` or `  methodName(...) { // comment }`
  // Negative lookahead excludes JS keywords to avoid matching `if (...) {}` as empty methods.
  {
    re: /^\s+(?!if\b|for\b|while\b|switch\b|do\b|catch\b|else\b|return\b|throw\b|new\b|typeof\b|try\b|class\b|const\b|let\b|var\b)\w+\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*)*\}/gim,
    label: "empty method body",
  },
]

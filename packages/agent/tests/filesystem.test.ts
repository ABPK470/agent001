/**
 * Filesystem tool tests — write_file integrity checks, inline stub detection,
 * function loss detection, and path security.
 *
 * Uses a real temp directory so write_file actually runs.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readFileTool, replaceInFileTool, setBasePath, writeFileTool } from "../src/tools/filesystem.js"

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-fs-test-"))
  setBasePath(tempDir)
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

// ============================================================================
// Inline stub detection in write_file
// ============================================================================

describe("write_file: inline stub detection", () => {
  it("warns when writing JS with placeholder comments", async () => {
    const result = await writeFileTool.execute({
      path: "game.js",
      content: [
        "function initBoard() { return []; }",
        "function isMoveLegal(from, to) {",
        "    // Placeholder for legal move logic",
        "    return true;",
        "}",
        "function renderBoard() {",
        "    const canvas = document.getElementById('board');",
        "    canvas.width = 640;",
        "    canvas.height = 640;",
        "}",
      ].join("\n"),
    })

    expect(result).toContain("STUB/PLACEHOLDER CODE DETECTED")
    expect(result).toContain("placeholder")
  })

  it("warns when writing JS with stub function (comment + trivial return)", async () => {
    const result = await writeFileTool.execute({
      path: "chess.js",
      content: [
        "function renderBoard() { /* real implementation */ document.body.innerHTML = 'board'; }",
        "function isCheckmate(board, color) {",
        "    // Check if the king is in checkmate",
        "    return false;",
        "}",
        "function isStalemate(board, color) {",
        "    // Check for stalemate condition",
        "    return false;",
        "}",
      ].join("\n"),
    })

    expect(result).toContain("STUB/PLACEHOLDER CODE DETECTED")
    expect(result).toContain("isCheckmate")
  })

  it("succeeds without warnings for real implementation code", async () => {
    const result = await writeFileTool.execute({
      path: "good-code.js",
      content: [
        "function isMoveLegal(piece, from, to) {",
        "    const dr = to[0] - from[0];",
        "    const dc = to[1] - from[1];",
        "    switch (piece) {",
        "        case 'pawn': return dc === 0 && dr === 1;",
        "        case 'rook': return dr === 0 || dc === 0;",
        "        case 'bishop': return Math.abs(dr) === Math.abs(dc);",
        "        case 'knight': return (Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2);",
        "        case 'queen': return dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc);",
        "        case 'king': return Math.abs(dr) <= 1 && Math.abs(dc) <= 1;",
        "        default: return false;",
        "    }",
        "}",
      ].join("\n"),
    })

    expect(result).toBe("Successfully wrote to good-code.js")
  })

  it("does NOT warn for non-code files (HTML, CSS, etc.)", async () => {
    const result = await writeFileTool.execute({
      path: "page.html",
      content: [
        "<!DOCTYPE html>",
        "<html>",
        "<head><title>Chess</title></head>",
        "<body>",
        "<!-- TODO: add board -->",
        '<div id="board"></div>',
        "<script src='game.js'></script>",
        "</body>",
        "</html>",
      ].join("\n"),
    })

    // HTML is not checked for stub patterns (only for HTML corruption)
    expect(result).toBe("Successfully wrote to page.html")
  })

  it("does NOT warn for tiny files under 50 chars", async () => {
    const result = await writeFileTool.execute({
      path: "tiny.js",
      content: "// TODO: implement",
    })

    // File too small to trigger stub detection (threshold is 50 chars)
    expect(result).toBe("Successfully wrote to tiny.js")
  })

  it("warns when writing JS with LLM degeneration comment", async () => {
    const result = await writeFileTool.execute({
      path: "degen.js",
      content: [
        "function getLegalMoves(row, col, piece) {",
        "  const moves = [];",
        "  const direction = piece === piece.toUpperCase() ? -1 : 1;",
        "",
        "  // Other code as per existing logic",
        "",
        "  return moves;",
        "}",
      ].join("\n"),
    })

    expect(result).toContain("degeneration")
    expect(result).not.toContain("CORRUPTED")
    expect(result).toContain("WRITTEN WITH ISSUES")
  })

  it("uses targeted message for stub-only issues (not CORRUPTED)", async () => {
    const result = await writeFileTool.execute({
      path: "stub-msg.js",
      content: [
        "function initBoard() { return []; }",
        "function isMoveLegal(from, to) {",
        "    // Placeholder for legal move logic",
        "    return true;",
        "}",
        "function renderBoard() {",
        "    const canvas = document.getElementById('board');",
        "    canvas.width = 640;",
        "    canvas.height = 640;",
        "}",
      ].join("\n"),
    })

    expect(result).toContain("WRITTEN WITH ISSUES")
    expect(result).not.toContain("CORRUPTED")
    expect(result).toContain("only replace the stub portions")
  })
})

// ============================================================================
// Function loss detection (regression guard)
// ============================================================================

describe("write_file: function loss detection", () => {
  it("warns when a rewrite drops existing functions", async () => {
    // First write: has initBoard, isMoveLegal, renderBoard
    await writeFileTool.execute({
      path: "chess-loss.js",
      content: [
        "function initBoard() { return Array(8).fill(null).map(() => Array(8).fill(null)); }",
        "function isMoveLegal(from, to) { return Math.abs(from[0]-to[0]) <= 1; }",
        "function renderBoard(board) { console.log(board); }",
      ].join("\n"),
    })

    // Second write: drops isMoveLegal and renderBoard
    const result = await writeFileTool.execute({
      path: "chess-loss.js",
      content: [
        "function initBoard() { return Array(8).fill(null).map(() => Array(8).fill(null)); }",
        "function newHelper() { return 42; }",
      ].join("\n"),
    })

    expect(result).toContain("FUNCTION LOSS")
    expect(result).toContain("isMoveLegal")
    expect(result).toContain("renderBoard")
  })

  it("does NOT warn when all functions are preserved", async () => {
    // First write
    await writeFileTool.execute({
      path: "chess-ok.js",
      content: [
        "function initBoard() { return []; }",
        "function renderBoard(b) { console.log(b); }",
      ].join("\n"),
    })

    // Second write: keeps both, adds more
    const result = await writeFileTool.execute({
      path: "chess-ok.js",
      content: [
        "function initBoard() { return Array(8).fill(null).map(() => Array(8).fill(null)); }",
        "function renderBoard(board) { board.forEach(r => console.log(r.join(' '))); }",
        "function isMoveLegal(from, to) { return from[0] !== to[0]; }",
      ].join("\n"),
    })

    expect(result).toBe("Successfully wrote to chess-ok.js")
  })

  it("rejects structural-corruption rewrites and keeps prior file intact", async () => {
    await writeFileTool.execute({
      path: "chess-atomic.js",
      content: [
        "function initBoard() { return []; }",
        "function renderBoard(board) { console.log(board); }",
      ].join("\n"),
    })

    const rejected = await writeFileTool.execute({
      path: "chess-atomic.js",
      content: [
        "function initBoard() {",
        "  const x = 1;",
        "}garbled output impossible token stream",
      ].join("\n"),
    })

    expect(rejected).toContain("WRITE REJECTED")

    const contentAfter = await readFileTool.execute({ path: "chess-atomic.js" })
    expect(contentAfter).toContain("function renderBoard")
    expect(contentAfter).not.toContain("garbled output impossible token stream")
  })
})

// ============================================================================
// LLM degeneration / corruption detection
// ============================================================================

describe("write_file: corruption detection", () => {
  it("warns on code-mixed-with-gibberish", async () => {
    const result = await writeFileTool.execute({
      path: "corrupt.js",
      content: [
        "function init() {",
        "  const board = [];",
        "  for (let i = 0; i < 8; i++) {",
        "    board.push([]);",
        "  }",
        "}valuator move saftey can ahead validated letinline acknowledge",
        "function render() {",
        "  console.log('hi');",
        "}",
      ].join("\n"),
    })

    expect(result).toContain("CORRUPTED")
    expect(result).toContain("gibberish")
  })

  it("warns on unclosed braces (truncated output)", async () => {
    const result = await writeFileTool.execute({
      path: "truncated.js",
      content: [
        "function outer() {",
        "  function inner() {",
        "    if (true) {",
        "      for (let i = 0; i < 10; i++) {",
        "        console.log(i);",
        "// file ends here, 3 unclosed braces",
      ].join("\n"),
    })

    expect(result).toContain("CORRUPTED")
    expect(result).toContain("unclosed brace")
  })

  it("does NOT warn on properly formatted code with matched braces", async () => {
    const result = await writeFileTool.execute({
      path: "clean.js",
      content: [
        "function outer() {",
        "  function inner() {",
        "    if (true) {",
        "      console.log('nested');",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    })

    expect(result).toBe("Successfully wrote to clean.js")
  })

  it("rejects pure gibberish with no code keywords", async () => {
    const result = await writeFileTool.execute({
      path: "gibberish.js",
      content: "[compacted \\u0001 full COMPL'd PROMO].THISs''. UPDATE! OFFCHAIN FINAL SCRIPT! INSERT_GAME_PATCH. wrapper + glbal dom visualization strict bind",
    })

    expect(result).toContain("GIBBERISH REJECTED")
  })

  it("rejects degenerated compaction output as gibberish", async () => {
    const result = await writeFileTool.execute({
      path: "compacted.js",
      content: "RESET PlaceholderINTRO.Handler-container validateManyCritical success BOILER<TAG> reinstated LEGAL WORKFLOW-safe cleaned Matrix operational",
    })

    expect(result).toContain("GIBBERISH REJECTED")
  })

  it("accepts valid JS with code keywords", async () => {
    const result = await writeFileTool.execute({
      path: "valid.js",
      content: [
        "const board = [];",
        "function init() {",
        "  for (let i = 0; i < 8; i++) {",
        "    board.push(new Array(8).fill(null));",
        "  }",
        "}",
      ].join("\n"),
    })

    expect(result).not.toContain("GIBBERISH")
  })

  it("does not flag throw new Error lines as gibberish", async () => {
    const result = await writeFileTool.execute({
      path: "valid-throw.js",
      content: [
        "function move(from) {",
        "  const piece = null;",
        "  if (!piece) throw new Error(`No piece at ${from}`);",
        "  return piece;",
        "}",
      ].join("\n"),
    })

    expect(result).toBe("Successfully wrote to valid-throw.js")
  })
})

// ============================================================================
// replace_in_file tool
// ============================================================================

describe("replace_in_file", () => {
  it("replaces a matching section in an existing file", async () => {
    await writeFileTool.execute({
      path: "replace-test.js",
      content: [
        "function alpha() { return 1; }",
        "function beta() { return 2; }",
        "function gamma() { return 3; }",
      ].join("\n"),
    })

    const result = await replaceInFileTool.execute({
      path: "replace-test.js",
      old_string: "function beta() { return 2; }",
      new_string: "function beta() { return 42; }",
    })

    expect(result).toBe("Successfully replaced in replace-test.js")
  })

  it("preserves all other content when replacing a section", async () => {
    await writeFileTool.execute({
      path: "replace-preserve.js",
      content: [
        "function a() { return 1; }",
        "function b() { return 2; }",
        "function c() { return 3; }",
      ].join("\n"),
    })

    await replaceInFileTool.execute({
      path: "replace-preserve.js",
      old_string: "function b() { return 2; }",
      new_string: "function b() { return 99; }",
    })

    // Read back and verify all functions exist
    const { readFile } = await import("node:fs/promises")
    const content = await readFile(join(tempDir, "replace-preserve.js"), "utf-8")
    expect(content).toContain("function a() { return 1; }")
    expect(content).toContain("function b() { return 99; }")
    expect(content).toContain("function c() { return 3; }")
  })

  it("returns error when file does not exist", async () => {
    const result = await replaceInFileTool.execute({
      path: "nonexistent-replace.js",
      old_string: "hello",
      new_string: "world",
    })

    expect(result).toContain("does not exist")
  })

  it("returns error when old_string is not found", async () => {
    await writeFileTool.execute({
      path: "replace-nomatch.js",
      content: "function foo() { return 1; }",
    })

    const result = await replaceInFileTool.execute({
      path: "replace-nomatch.js",
      old_string: "function bar() { return 2; }",
      new_string: "function bar() { return 42; }",
    })

    expect(result).toContain("not found")
  })

  it("detects stubs in replacement content", async () => {
    await writeFileTool.execute({
      path: "replace-stub.js",
      content: [
        "function validate(input) {",
        "  if (input.length < 3) return false;",
        "  if (input.length > 100) return false;",
        "  return /^[a-zA-Z]+$/.test(input);",
        "}",
      ].join("\n"),
    })

    const result = await replaceInFileTool.execute({
      path: "replace-stub.js",
      old_string: [
        "function validate(input) {",
        "  if (input.length < 3) return false;",
        "  if (input.length > 100) return false;",
        "  return /^[a-zA-Z]+$/.test(input);",
        "}",
      ].join("\n"),
      new_string: [
        "function validate(input) {",
        "  // TODO: implement validation",
        "  return true;",
        "}",
      ].join("\n"),
    })

    expect(result).toContain("STUB")
  })
})

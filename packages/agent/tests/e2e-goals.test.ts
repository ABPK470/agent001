/**
 * End-to-end integration tests — 10+ real goal scenarios testing the full
 * agent pipeline with scripted LLM, real filesystem tools, and all guards.
 *
 * Each test simulates a realistic agent interaction pattern:
 *   - The LLM follows a scripted sequence (writes files, reads, verifies)
 *   - The filesystem tools actually write/read from a temp directory
 *   - Guards fire when appropriate (completion validator, write-without-verify, etc.)
 *   - The final artifacts are checked on disk
 *
 * These are the tests that would have caught the chess game failures.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Agent } from "../src/agent.js"
import { detectPlaceholderPatterns } from "../src/code-quality.js"
import { normalizeToolExecutionOutput } from "../src/tool-utils.js"
import { listDirectoryTool, readFileTool, setBasePath, writeFileTool } from "../src/tools/filesystem.js"
import type { LLMClient, LLMResponse, Tool } from "../src/types.js"

// ── Helpers ──────────────────────────────────────────────────────

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-e2e-"))
  setBasePath(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function scriptedLLM(responses: LLMResponse[]): LLMClient {
  let callIndex = 0
  return {
    async chat() {
      if (callIndex >= responses.length) {
        return { content: "out of script", toolCalls: [] }
      }
      return responses[callIndex++]!
    },
  }
}

const fsTools = [readFileTool, writeFileTool, listDirectoryTool]

function toToolText(value: string | object): string {
  return normalizeToolExecutionOutput(value as string).result
}

// ============================================================================
// Scenario 1: Simple file creation — write a single file, done
// ============================================================================

describe("E2E: simple file creation", () => {
  it("creates an HTML file and exits cleanly", async () => {
    const nudges: string[] = []

    const llm = scriptedLLM([
      {
        content: "Creating index.html",
        toolCalls: [{
          id: "tc1",
          name: "write_file",
          arguments: {
            path: "index.html",
            content: "<!DOCTYPE html>\n<html>\n<head><title>Test</title></head>\n<body><h1>Hello World</h1></body>\n</html>",
          },
        }],
      },
      {
        content: "Verifying the file",
        toolCalls: [{
          id: "tc2",
          name: "read_file",
          arguments: { path: "index.html" },
        }],
      },
      { content: "Created index.html with Hello World heading", toolCalls: [] },
    ])

    const agent = new Agent(llm, fsTools, {
      verbose: false,
      onNudge: (d) => nudges.push(d.tag),
    })
    const answer = await agent.run("Create a simple HTML page")

    // File should exist on disk
    const content = await readFile(join(tempDir, "index.html"), "utf-8")
    expect(content).toContain("<h1>Hello World</h1>")
    expect(nudges).toHaveLength(0)
    expect(answer).toContain("index.html")
  })
})

// ============================================================================
// Scenario 2: Chess game with stubs — completionValidator catches it
// ============================================================================

describe("E2E: chess game with stub detection", () => {
  it("completionValidator blocks exit when code has stubs", async () => {
    const nudges: string[] = []

    const stubChessCode = [
      "const board = [];",
      "function initBoard() {",
      "  for (let r = 0; r < 8; r++) {",
      "    board[r] = [];",
      "    for (let c = 0; c < 8; c++) {",
      "      board[r][c] = null;",
      "    }",
      "  }",
      "}",
      "function isMoveLegal(from, to) {",
      "    // Placeholder for legal move logic",
      "    return true;",
      "}",
      "function renderBoard() {",
      "  const el = document.getElementById('board');",
      "  el.innerHTML = '';",
      "  for (let r = 0; r < 8; r++) {",
      "    for (let c = 0; c < 8; c++) {",
      "      const sq = document.createElement('div');",
      "      sq.className = 'square';",
      "      el.appendChild(sq);",
      "    }",
      "  }",
      "}",
    ].join("\n")

    const fixedChessCode = [
      "const board = [];",
      "function initBoard() {",
      "  for (let r = 0; r < 8; r++) {",
      "    board[r] = [];",
      "    for (let c = 0; c < 8; c++) {",
      "      board[r][c] = null;",
      "    }",
      "  }",
      "}",
      "function isMoveLegal(piece, from, to) {",
      "  const dr = to[0] - from[0];",
      "  const dc = to[1] - from[1];",
      "  switch (piece) {",
      "    case 'pawn': return dc === 0 && Math.abs(dr) === 1;",
      "    case 'rook': return dr === 0 || dc === 0;",
      "    case 'bishop': return Math.abs(dr) === Math.abs(dc);",
      "    case 'knight': return (Math.abs(dr)===2 && Math.abs(dc)===1) || (Math.abs(dr)===1 && Math.abs(dc)===2);",
      "    case 'queen': return dr===0 || dc===0 || Math.abs(dr)===Math.abs(dc);",
      "    case 'king': return Math.abs(dr)<=1 && Math.abs(dc)<=1;",
      "    default: return false;",
      "  }",
      "}",
      "function renderBoard() {",
      "  const el = document.getElementById('board');",
      "  el.innerHTML = '';",
      "  for (let r = 0; r < 8; r++) {",
      "    for (let c = 0; c < 8; c++) {",
      "      const sq = document.createElement('div');",
      "      sq.className = 'square';",
      "      el.appendChild(sq);",
      "    }",
      "  }",
      "}",
    ].join("\n")

    const llm = scriptedLLM([
      // Iter 0: write stub code
      {
        content: "Writing chess game",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: { path: "game.js", content: stubChessCode },
        }],
      },
      // Iter 1: read to verify (clears wroteUnverifiedFiles)
      {
        content: "Reviewing my code",
        toolCalls: [{
          id: "tc2", name: "read_file",
          arguments: { path: "game.js" },
        }],
      },
      // Iter 2: tries to exit → completionValidator fires
      { content: "Chess game complete", toolCalls: [] },
      // Iter 3: forced to fix — rewrites with real implementation
      {
        content: "Fixing the stub functions",
        toolCalls: [{
          id: "tc3", name: "write_file",
          arguments: { path: "game.js", content: fixedChessCode },
        }],
      },
      // Iter 4: reads to verify again
      {
        content: null,
        toolCalls: [{
          id: "tc4", name: "read_file",
          arguments: { path: "game.js" },
        }],
      },
      // Iter 5: exits — validator already fired (one-shot)
      { content: "Chess game with complete move validation", toolCalls: [] },
    ])

    // Set up the completion validator (simulating what delegate.ts does)
    const agent = new Agent(llm, fsTools, {
      verbose: false,
      onNudge: (d) => nudges.push(d.tag),
      completionValidator: async () => {
        try {
          const code = await readFile(join(tempDir, "game.js"), "utf-8")
          const findings = detectPlaceholderPatterns(code)
          if (findings.length > 0) {
            return `COMPLETION CHECK FAILED — stubs found:\n${findings.map(f => `  - ${f}`).join("\n")}`
          }
        } catch { /* file not created yet */ }
        return null
      },
    })

    const answer = await agent.run("Build a chess game")

    // The completion-validator should have fired
    expect(nudges).toContain("completion-validator")

    // Final file should have real code, not stubs
    const finalCode = await readFile(join(tempDir, "game.js"), "utf-8")
    const finalFindings = detectPlaceholderPatterns(finalCode)
    expect(finalFindings).toHaveLength(0)
    expect(finalCode).toContain("switch")
    expect(finalCode).toContain("pawn")
  })
})

// ============================================================================
// Scenario 3: Write-without-verify guard
// ============================================================================

describe("E2E: write-without-verify guard", () => {
  it("forces verification when agent writes JS and tries to exit", async () => {
    const nudges: string[] = []

    const llm = scriptedLLM([
      // Iter 0: write a file
      {
        content: "Writing app.js",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: { path: "app.js", content: "function main() {\n  console.log('Hello');\n}\nmain();" },
        }],
      },
      // Iter 1: tries to exit without reading
      { content: "All done!", toolCalls: [] },
      // Iter 2: forced to verify — reads the file
      {
        content: "Let me verify",
        toolCalls: [{ id: "tc2", name: "read_file", arguments: { path: "app.js" } }],
      },
      // Iter 3: exits
      { content: "Verified — app.js works correctly", toolCalls: [] },
    ])

    const agent = new Agent(llm, fsTools, {
      verbose: false,
      onNudge: (d) => nudges.push(d.tag),
    })
    await agent.run("Create a simple app")

    expect(nudges).toContain("write-without-verify")
    // File should exist
    const content = await readFile(join(tempDir, "app.js"), "utf-8")
    expect(content).toContain("main()")
  })
})

// ============================================================================
// Scenario 4: Multi-file project — HTML + CSS + JS
// ============================================================================

describe("E2E: multi-file project creation", () => {
  it("creates HTML, CSS, and JS files for a complete project", async () => {
    const llm = scriptedLLM([
      // Iter 0: write HTML
      {
        content: "Creating HTML",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: {
            path: "index.html",
            content: '<!DOCTYPE html>\n<html>\n<head>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n<div id="app"></div>\n<script src="app.js"></script>\n</body>\n</html>',
          },
        }],
      },
      // Iter 1: write CSS
      {
        content: "Creating CSS",
        toolCalls: [{
          id: "tc2", name: "write_file",
          arguments: {
            path: "styles.css",
            content: "body { font-family: sans-serif; margin: 0; }\n#app { max-width: 800px; margin: 0 auto; padding: 20px; }",
          },
        }],
      },
      // Iter 2: write JS
      {
        content: "Creating JS",
        toolCalls: [{
          id: "tc3", name: "write_file",
          arguments: {
            path: "app.js",
            content: "document.getElementById('app').innerHTML = '<h1>Todo App</h1><ul id=\"list\"></ul>';\nfunction addItem(text) {\n  const li = document.createElement('li');\n  li.textContent = text;\n  document.getElementById('list').appendChild(li);\n}",
          },
        }],
      },
      // Iter 3: verify by reading
      {
        content: "Verifying",
        toolCalls: [
          { id: "tc4", name: "read_file", arguments: { path: "index.html" } },
          { id: "tc5", name: "read_file", arguments: { path: "app.js" } },
        ],
      },
      { content: "Created a complete todo app with HTML, CSS, and JS", toolCalls: [] },
    ])

    const agent = new Agent(llm, fsTools, { verbose: false })
    const answer = await agent.run("Create a todo app")

    // All 3 files should exist
    const html = await readFile(join(tempDir, "index.html"), "utf-8")
    const css = await readFile(join(tempDir, "styles.css"), "utf-8")
    const js = await readFile(join(tempDir, "app.js"), "utf-8")

    expect(html).toContain("app.js")
    expect(css).toContain("font-family")
    expect(js).toContain("addItem")
    expect(answer).toBeTruthy()
  })
})

// ============================================================================
// Scenario 5: Inline stub warning at write time
// ============================================================================

describe("E2E: inline stub detection during write", () => {
  it("write_file returns warning when code contains stubs", async () => {
    const toolResults: string[] = []

    const llm = scriptedLLM([
      // Iter 0: writes code with a stub — should get warning in tool result
      {
        content: "Writing game logic",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: {
            path: "logic.js",
            content: [
              "function calculate(a, b) { return a + b; }",
              "function isCheckmate(board, color) {",
              "    // TODO: implement checkmate detection",
              "    return false;",
              "}",
              "function render() { document.body.innerHTML = 'game'; }",
            ].join("\n"),
          },
        }],
      },
      // Iter 1: the new artifact guard requires a read before another mutation
      {
        content: "Inspecting the current file before repair",
        toolCalls: [{ id: "tc-read-logic", name: "read_file", arguments: { path: "logic.js" } }],
      },
      // Iter 2: repair after inspection
      {
        content: "Fixing the stubs",
        toolCalls: [{
          id: "tc2", name: "write_file",
          arguments: {
            path: "logic.js",
            content: [
              "function calculate(a, b) { return a + b; }",
              "function isCheckmate(board, color) {",
              "    const king = findKing(board, color);",
              "    if (!king) return false;",
              "    const moves = getAllLegalMoves(board, color);",
              "    return moves.length === 0 && isInCheck(board, color);",
              "}",
              "function render() { document.body.innerHTML = 'game'; }",
            ].join("\n"),
          },
        }],
      },
      // Iter 3: reads to verify
      {
        content: null,
        toolCalls: [{ id: "tc3", name: "read_file", arguments: { path: "logic.js" } }],
      },
      { content: "Done — all functions have real implementations", toolCalls: [] },
    ])

    // Intercept tool results to check what write_file returned
    const wrappedWriteFile: Tool = {
      ...writeFileTool,
      async execute(args) {
        const result = await writeFileTool.execute(args)
        toolResults.push(toToolText(result as string | object))
        return result
      },
    }

    const agent = new Agent(llm, [wrappedWriteFile, readFileTool], { verbose: false })
    await agent.run("Build game logic")

    // First write should have had a stub warning
    expect(toolResults[0]).toContain("STUB/PLACEHOLDER CODE DETECTED")
    // Second write should be clean
    expect(toolResults[1]).toBe("Successfully wrote to logic.js")
  })
})

// ============================================================================
// Scenario 6: Function loss detection on rewrite
// ============================================================================

describe("E2E: function loss prevention", () => {
  it("prevents a rewrite from deleting existing functions", async () => {
    const llm = scriptedLLM([
      // Iter 0: writes 3 functions
      {
        content: "Writing initial code",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: {
            path: "game.js",
            content: "function initBoard() { return []; }\nfunction movePiece(from, to) { board[to] = board[from]; board[from] = null; }\nfunction renderBoard() { const el = document.getElementById('board'); el.textContent = JSON.stringify(board); }",
          },
        }],
      },
      // Iter 1: rewrites but drops movePiece
      {
        content: "Improving the code",
        toolCalls: [{
          id: "tc2", name: "write_file",
          arguments: {
            path: "game.js",
            content: "function initBoard() { return Array(64).fill(null); }\nfunction renderBoard() { const el = document.getElementById('board'); el.innerHTML = board.map(p => p || '.').join(''); }",
          },
        }],
      },
      // Iter 2: read current file before retrying mutation on the same artifact
      {
        content: "Inspecting the current file after the failed rewrite",
        toolCalls: [{ id: "tc2b", name: "read_file", arguments: { path: "game.js" } }],
      },
      // Iter 3: reads to check
      {
        content: null,
        toolCalls: [{ id: "tc3", name: "read_file", arguments: { path: "game.js" } }],
      },
      { content: "Done", toolCalls: [] },
    ])

    const agent = new Agent(llm, [writeFileTool, readFileTool], { verbose: false })
    await agent.run("Improve the game")

    const finalCode = await readFile(join(tempDir, "game.js"), "utf-8")
    expect(finalCode).toContain("movePiece")
    expect(finalCode).toContain("renderBoard")
  })
})

// ============================================================================
// Scenario 7: Corruption detection — gibberish in output
// ============================================================================

describe("E2E: corruption detection", () => {
  it("warns when LLM output contains gibberish mixed with code", async () => {
    const toolResults: string[] = []

    const llm = scriptedLLM([
      {
        content: "Writing code",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: {
            path: "corrupted.js",
            content: [
              "function init() {",
              "  const board = [];",
              "  for (let i = 0; i < 8; i++) {",
              "    board.push(Array(8).fill(null));",
              "  }",
              "}validator move safety checking ahead validated letinline acknowledge",
              "function render() {",
              "  console.log('done');",
              "}",
            ].join("\n"),
          },
        }],
      },
      { content: "Done", toolCalls: [] },
    ])

    const wrappedWriteFile: Tool = {
      ...writeFileTool,
      async execute(args) {
        const result = await writeFileTool.execute(args)
        toolResults.push(toToolText(result as string | object))
        return result
      },
    }

    const agent = new Agent(llm, [wrappedWriteFile], { verbose: false })
    await agent.run("Write some code")

    expect(toolResults[0]).toContain("WRITE REJECTED")
    expect(toolResults[0]).toContain("gibberish")
  })
})

// ============================================================================
// Scenario 8: Early exit prevention
// ============================================================================

describe("E2E: early exit prevention", () => {
  it("prevents agent from exiting on iteration 0 without using tools", async () => {
    const nudges: string[] = []

    const llm = scriptedLLM([
      // Iter 0: tries to exit immediately with a text answer
      { content: "Sure, I can see it's a simple task. The answer is 42.", toolCalls: [] },
      // Iter 1: forced to use tools
      {
        content: "Let me actually do the work",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: { path: "result.txt", content: "42" },
        }],
      },
      // Iter 2: reads to verify
      {
        content: null,
        toolCalls: [{ id: "tc2", name: "read_file", arguments: { path: "result.txt" } }],
      },
      { content: "Created result.txt with the answer", toolCalls: [] },
    ])

    const agent = new Agent(llm, fsTools, {
      verbose: false,
      onNudge: (d) => nudges.push(d.tag),
    })
    const answer = await agent.run("Create a file with the number 42")

    expect(nudges).toContain("early-exit-nudge")
    const content = await readFile(join(tempDir, "result.txt"), "utf-8")
    expect(content).toBe("42")
  })
})

// ============================================================================
// Scenario 9: Calculator app — real implementation with no false positives
// ============================================================================

describe("E2E: calculator app — no false positives", () => {
  it("accepts a complete calculator without triggering stub detection", async () => {
    const nudges: string[] = []

    const calculatorCode = [
      "let display = '0';",
      "let operator = null;",
      "let operandA = null;",
      "",
      "function pressDigit(d) {",
      "  if (display === '0') display = String(d);",
      "  else display += String(d);",
      "  updateDisplay();",
      "}",
      "",
      "function pressOperator(op) {",
      "  operandA = parseFloat(display);",
      "  operator = op;",
      "  display = '0';",
      "}",
      "",
      "function calculate() {",
      "  const b = parseFloat(display);",
      "  switch (operator) {",
      "    case '+': display = String(operandA + b); break;",
      "    case '-': display = String(operandA - b); break;",
      "    case '*': display = String(operandA * b); break;",
      "    case '/': display = b !== 0 ? String(operandA / b) : 'Error'; break;",
      "  }",
      "  operator = null;",
      "  updateDisplay();",
      "}",
      "",
      "function updateDisplay() {",
      "  document.getElementById('display').textContent = display;",
      "}",
      "",
      "function clearAll() {",
      "  display = '0';",
      "  operator = null;",
      "  operandA = null;",
      "  updateDisplay();",
      "}",
    ].join("\n")

    const llm = scriptedLLM([
      {
        content: "Writing calculator",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: { path: "calc.js", content: calculatorCode },
        }],
      },
      {
        content: "Verifying",
        toolCalls: [{ id: "tc2", name: "read_file", arguments: { path: "calc.js" } }],
      },
      { content: "Calculator app created successfully", toolCalls: [] },
    ])

    const agent = new Agent(llm, fsTools, {
      verbose: false,
      onNudge: (d) => nudges.push(d.tag),
      completionValidator: async () => {
        try {
          const code = await readFile(join(tempDir, "calc.js"), "utf-8")
          const findings = detectPlaceholderPatterns(code)
          if (findings.length > 0) {
            return `STUBS:\n${findings.join("\n")}`
          }
        } catch { /* */ }
        return null
      },
    })
    const answer = await agent.run("Build a calculator")

    // Should NOT trigger false positive detection
    expect(nudges).not.toContain("completion-validator")
    expect(answer).toContain("Calculator")
  })
})

// ============================================================================
// Scenario 10: Snake game — complex project, all clean
// ============================================================================

describe("E2E: snake game — complex clean project", () => {
  it("creates a working snake game without triggering any guards", async () => {
    const nudges: string[] = []

    const snakeCode = [
      "const GRID = 20;",
      "const CELL = 20;",
      "let snake = [{x:10,y:10}];",
      "let dir = {x:1,y:0};",
      "let food = {x:15,y:15};",
      "let score = 0;",
      "let gameOver = false;",
      "",
      "const canvas = document.getElementById('canvas');",
      "const ctx = canvas.getContext('2d');",
      "canvas.width = GRID * CELL;",
      "canvas.height = GRID * CELL;",
      "",
      "function update() {",
      "  if (gameOver) return;",
      "  const head = {x: snake[0].x + dir.x, y: snake[0].y + dir.y};",
      "  if (head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID) { gameOver = true; return; }",
      "  if (snake.some(s => s.x === head.x && s.y === head.y)) { gameOver = true; return; }",
      "  snake.unshift(head);",
      "  if (head.x === food.x && head.y === food.y) {",
      "    score++;",
      "    spawnFood();",
      "  } else {",
      "    snake.pop();",
      "  }",
      "}",
      "",
      "function spawnFood() {",
      "  do { food = {x: Math.floor(Math.random()*GRID), y: Math.floor(Math.random()*GRID)}; }",
      "  while (snake.some(s => s.x === food.x && s.y === food.y));",
      "}",
      "",
      "function draw() {",
      "  ctx.fillStyle = '#222';",
      "  ctx.fillRect(0,0,canvas.width,canvas.height);",
      "  ctx.fillStyle = '#0f0';",
      "  for (const s of snake) ctx.fillRect(s.x*CELL,s.y*CELL,CELL-1,CELL-1);",
      "  ctx.fillStyle = '#f00';",
      "  ctx.fillRect(food.x*CELL,food.y*CELL,CELL-1,CELL-1);",
      "  ctx.fillStyle = '#fff';",
      "  ctx.font = '16px monospace';",
      "  ctx.fillText('Score: ' + score, 10, canvas.height - 10);",
      "  if (gameOver) { ctx.fillText('GAME OVER', canvas.width/2-50, canvas.height/2); }",
      "}",
      "",
      "document.addEventListener('keydown', e => {",
      "  switch(e.key) {",
      "    case 'ArrowUp': if (dir.y !== 1) dir = {x:0,y:-1}; break;",
      "    case 'ArrowDown': if (dir.y !== -1) dir = {x:0,y:1}; break;",
      "    case 'ArrowLeft': if (dir.x !== 1) dir = {x:-1,y:0}; break;",
      "    case 'ArrowRight': if (dir.x !== -1) dir = {x:1,y:0}; break;",
      "  }",
      "});",
      "",
      "setInterval(() => { update(); draw(); }, 100);",
    ].join("\n")

    const llm = scriptedLLM([
      {
        content: "Creating HTML",
        toolCalls: [{
          id: "tc1", name: "write_file",
          arguments: {
            path: "index.html",
            content: '<!DOCTYPE html>\n<html>\n<head><title>Snake</title>\n<style>body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;background:#111}</style>\n</head>\n<body>\n<canvas id="canvas"></canvas>\n<script src="snake.js"></script>\n</body>\n</html>',
          },
        }],
      },
      {
        content: "Creating snake game logic",
        toolCalls: [{
          id: "tc2", name: "write_file",
          arguments: { path: "snake.js", content: snakeCode },
        }],
      },
      {
        content: "Verifying files",
        toolCalls: [
          { id: "tc3", name: "read_file", arguments: { path: "index.html" } },
          { id: "tc4", name: "read_file", arguments: { path: "snake.js" } },
        ],
      },
      { content: "Complete snake game with collision detection, scoring, and rendering", toolCalls: [] },
    ])

    const agent = new Agent(llm, fsTools, {
      verbose: false,
      onNudge: (d) => nudges.push(d.tag),
      completionValidator: async () => {
        try {
          const code = await readFile(join(tempDir, "snake.js"), "utf-8")
          const findings = detectPlaceholderPatterns(code)
          if (findings.length > 0) return `STUBS:\n${findings.join("\n")}`
        } catch { /* */ }
        return null
      },
    })
    const answer = await agent.run("Build a snake game")

    // No guards should fire
    expect(nudges).toHaveLength(0)

    // Files should exist and be real code
    const html = await readFile(join(tempDir, "index.html"), "utf-8")
    const js = await readFile(join(tempDir, "snake.js"), "utf-8")
    expect(html).toContain("canvas")
    expect(js).toContain("gameOver")
    expect(js).toContain("spawnFood")
    expect(detectPlaceholderPatterns(js)).toHaveLength(0)
  })
})

// ============================================================================
// Scenario 11: Tic-tac-toe with AI — detects catch-all pattern
// ============================================================================

describe("E2E: tic-tac-toe with catch-all detection", () => {
  it("detects catch-all return true in isValidMove", async () => {
    const stubTicTacToe = [
      "let board = Array(9).fill(null);",
      "let currentPlayer = 'X';",
      "",
      "function isValidMove(index) {",
      "  if (index < 0) return false;",
      "  if (index > 8) return false;",
      "  return true;",
      "}",
      "",
      "function makeMove(index) {",
      "  board[index] = currentPlayer;",
      "  currentPlayer = currentPlayer === 'X' ? 'O' : 'X';",
      "}",
      "",
      "function checkWinner() {",
      "  const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];",
      "  for (const [a,b,c] of wins) {",
      "    if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];",
      "  }",
      "  return null;",
      "}",
    ].join("\n")

    // isValidMove should check board[index] === null, but it catches-all with return true
    const findings = detectPlaceholderPatterns(stubTicTacToe)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.some(f => f.includes("isValidMove"))).toBe(true)
  })
})

// ============================================================================
// Scenario 12: Memory/weather app — mixed real + stub
// ============================================================================

describe("E2E: app with mixed real and stub functions", () => {
  it("detects only the stub function, not the real ones", async () => {
    const mixedCode = [
      "// Weather dashboard",
      "function formatTemperature(celsius) {",
      "  return Math.round(celsius) + '°C';",
      "}",
      "",
      "function formatDate(timestamp) {",
      "  const d = new Date(timestamp * 1000);",
      "  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });",
      "}",
      "",
      "function getWindDirection(degrees) {",
      "  const dirs = ['N','NE','E','SE','S','SW','W','NW'];",
      "  return dirs[Math.round(degrees / 45) % 8];",
      "}",
      "",
      "function calculateHeatIndex(temp, humidity) {",
      "  // TODO implement heat index formula",
      "  return temp;",
      "}",
      "",
      "function renderForecast(data) {",
      "  const container = document.getElementById('forecast');",
      "  container.innerHTML = '';",
      "  for (const day of data.daily) {",
      "    const el = document.createElement('div');",
      "    el.className = 'forecast-day';",
      "    el.innerHTML = '<span>' + formatDate(day.dt) + '</span><span>' + formatTemperature(day.temp.max) + '</span>';",
      "    container.appendChild(el);",
      "  }",
      "}",
    ].join("\n")

    const findings = detectPlaceholderPatterns(mixedCode)
    // The TODO comment triggers "placeholder comment" detection
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.some(f => /placeholder comment/i.test(f))).toBe(true)
    // Should NOT flag the real functions
    const joinedFindings = findings.join(" ")
    expect(joinedFindings).not.toContain("formatTemperature")
    expect(joinedFindings).not.toContain("formatDate")
    expect(joinedFindings).not.toContain("getWindDirection")
    expect(joinedFindings).not.toContain("renderForecast")
  })
})

// ============================================================================
// Scenario 13: Budget warning fires near end of iteration budget
// ============================================================================

describe("E2E: budget warning at low iteration count", () => {
  it("warns when close to iteration limit", async () => {
    const nudges: string[] = []

    // Agent-guards.test.ts proves this pattern works with echoTool.
    // Mirror the same pattern here but with filesystem tools.
    const tool: Tool = {
      name: "echo",
      description: "Echo tool",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      async execute(args) { return `echoed: ${String(args.text)}` },
    }

    const llm = scriptedLLM([
      // Iter 0: work
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "1" } }] },
      // Iter 1: budget warning fires (remaining=2, threshold=max(ceil(3*0.2),2)=2)
      { content: null, toolCalls: [{ id: "tc2", name: "echo", arguments: { text: "2" } }] },
      // Iter 2: done
      { content: "Done", toolCalls: [] },
    ])

    const agent = new Agent(llm, [tool], {
      maxIterations: 3,
      verbose: false,
      onNudge: (d) => nudges.push(d.tag),
    })
    await agent.run("Create files")

    expect(nudges).toContain("budget-warning")
  })
})

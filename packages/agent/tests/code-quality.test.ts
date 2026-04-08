/**
 * Code quality detection tests — hardcoded cases from real agent traces.
 *
 * Tests PLACEHOLDER_PATTERNS, detectPlaceholderPatterns(), and detectCatchAllReturns()
 * against actual stub code produced by child agents in production runs.
 */
import { describe, expect, it } from "vitest"
import {
    detectCatchAllReturns,
    detectPlaceholderPatterns,
    PLACEHOLDER_PATTERNS,
} from "../src/code-quality.js"

// ============================================================================
// Real stub code samples from agent traces
// ============================================================================

/** From trace agent-loop-2026-04-08: child iter 4 writes isMoveLegal stub */
const CHESS_STUB_PLACEHOLDER_COMMENT = `
function initBoard() {
  const board = [];
  for (let r = 0; r < 8; r++) {
    board[r] = [];
    for (let c = 0; c < 8; c++) {
      board[r][c] = INITIAL_BOARD[r][c];
    }
  }
  return board;
}

function isMoveLegal(from, to) {
    // Placeholder for legal move logic
    return true; // (Temporary: Allow all moves)
}

function highlightMoves(row, col) {
    // Temporary basic movement logic (allow moves to any empty square)
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (!board[r][c]) targetSquare.classList.add("highlight");
        }
    }
}
`

/** Stub: validation function that always returns true (no comment) */
const CHESS_STUB_TRIVIAL_RETURN = `
function isInCheck(board, color) {
    return false;
}

function isCheckmate(board, color) {
    return false;
}

function isStalemate(board, color) {
    return false;
}
`

/** Stub: comment + trivial return (common pattern) */
const CHESS_STUB_COMMENT_PLUS_RETURN = `
function isCheckmate(board, color) {
    // Check if the king is in checkmate
    return false;
}

function calculateRookMoves(row, col) {
    // Calculate rook moves along ranks and files
    return [];
}

function getBishopAttacks(row, col) {
    /* diagonal movement logic */
    return [];
}
`

/** Stub: empty function body */
const STUB_EMPTY_BODY = `
function calculateLegalMoves(piece, row, col) {
    // Will add move calculation logic
}

function handleCastling(king, rook) {
    // TODO: implement castling
}
`

/** Stub: arrow function returning constant */
const STUB_ARROW_CONST = `
const isValidMove = (from, to) => true;
const canCastle = (side) => false;
`

/** Stub: arrow function returning empty array/object */
const STUB_ARROW_EMPTY = `
const getLegalMoves = (piece, pos) => [];
const getGameState = () => ({});
`

/** Deferred-work comments */
const STUB_DEFERRED = `
function renderBoard() {
  const canvas = document.getElementById('board');
  // Drawing logic will go here
  canvas.width = 640;
}

function handlePromotion(pawn) {
  // Promotion handling will be added later
  return pawn;
}

function setupAI() {
  // AI engine goes here
}
`

/** Stub: "to be implemented" variant */
const STUB_TO_BE_IMPLEMENTED = `
function validateInput(data) {
  // Input validation to be implemented
  return true;
}

function processPayment(order) {
  // Payment processing not yet implemented
  return null;
}
`

/** REAL chess implementation — should NOT trigger */
const REAL_CHESS_MOVE_VALIDATION = `
function isMoveLegal([row, col], [newRow, newCol]) {
    const piece = board[row][col];
    if (!piece) return false;
    const type = piece.toLowerCase();
    const isWhite = piece === piece.toUpperCase();
    const target = board[newRow][newCol];
    if (target && (target === target.toUpperCase()) === isWhite) return false;
    const dr = newRow - row;
    const dc = newCol - col;
    
    switch (type) {
        case 'p': {
            const dir = isWhite ? -1 : 1;
            if (dc === 0 && dr === dir && !target) return true;
            if (dc === 0 && dr === 2 * dir && row === (isWhite ? 6 : 1) && !target && !board[row + dir][col]) return true;
            if (Math.abs(dc) === 1 && dr === dir && target) return true;
            return false;
        }
        case 'n':
            return (Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2);
        case 'b':
            if (Math.abs(dr) !== Math.abs(dc)) return false;
            return isPathClear(row, col, newRow, newCol);
        case 'r':
            if (dr !== 0 && dc !== 0) return false;
            return isPathClear(row, col, newRow, newCol);
        case 'q':
            if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) return false;
            return isPathClear(row, col, newRow, newCol);
        case 'k':
            return Math.abs(dr) <= 1 && Math.abs(dc) <= 1;
        default:
            return false;
    }
}

function isPathClear(r1, c1, r2, c2) {
    const dr = Math.sign(r2 - r1);
    const dc = Math.sign(c2 - c1);
    let r = r1 + dr, c = c1 + dc;
    while (r !== r2 || c !== c2) {
        if (board[r][c]) return false;
        r += dr;
        c += dc;
    }
    return board[r2][c2] === null || isColor(board[r2][c2], enemyColor);
}

function isInCheck(board, color) {
    const kingPos = findKing(board, color);
    if (!kingPos) return false;
    const enemy = color === 'white' ? 'black' : 'white';
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = board[r][c];
            if (piece && isColor(piece, enemy)) {
                if (canAttack(piece, [r, c], kingPos, board)) return true;
            }
        }
    }
    return false;
}
`

/** REAL todo-app implementation — should NOT trigger */
const REAL_TODO_APP = `
function addTodo(text) {
    const li = document.createElement('li');
    li.textContent = text;
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => li.remove());
    li.appendChild(deleteBtn);
    li.addEventListener('click', () => li.classList.toggle('completed'));
    document.getElementById('task-list').appendChild(li);
    document.getElementById('task-input').value = '';
}

function filterTodos(filter) {
    const items = document.querySelectorAll('#task-list li');
    items.forEach(item => {
        switch (filter) {
            case 'all': item.style.display = ''; break;
            case 'active': item.style.display = item.classList.contains('completed') ? 'none' : ''; break;
            case 'completed': item.style.display = item.classList.contains('completed') ? '' : 'none'; break;
        }
    });
}
`

/** REAL calculator — should NOT trigger */
const REAL_CALCULATOR = `
function calculate(a, op, b) {
    switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b !== 0 ? a / b : 'Error: Division by zero';
        case '%': return a % b;
        case '**': return Math.pow(a, b);
        default: return 'Error: Unknown operator';
    }
}
`

// ============================================================================
// Tests
// ============================================================================

describe("code-quality: detectPlaceholderPatterns", () => {
  describe("detects real stub patterns from traces", () => {
    it("detects placeholder comments (Placeholder for…)", () => {
      const findings = detectPlaceholderPatterns(CHESS_STUB_PLACEHOLDER_COMMENT)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/placeholder/i)
    })

    it("detects validation functions always returning constant", () => {
      const findings = detectPlaceholderPatterns(CHESS_STUB_TRIVIAL_RETURN)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/isInCheck|isCheckmate|isStalemate/i)
    })

    it("detects comment + trivial return stubs", () => {
      const findings = detectPlaceholderPatterns(CHESS_STUB_COMMENT_PLUS_RETURN)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/isCheckmate|calculateRookMoves|getBishopAttacks/i)
    })

    it("detects empty function bodies", () => {
      const findings = detectPlaceholderPatterns(STUB_EMPTY_BODY)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/empty function body|placeholder comment/i)
    })

    it("detects arrow function stubs returning constant", () => {
      const findings = detectPlaceholderPatterns(STUB_ARROW_CONST)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/isValidMove|canCastle/i)
    })

    it("detects arrow function stubs returning empty array/object", () => {
      const findings = detectPlaceholderPatterns(STUB_ARROW_EMPTY)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/arrow.*empty/i)
    })

    it("detects deferred-work comments (goes here, will be added)", () => {
      const findings = detectPlaceholderPatterns(STUB_DEFERRED)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/deferred-work comment/i)
    })

    it("detects 'to be implemented' / 'not yet implemented' comments", () => {
      const findings = detectPlaceholderPatterns(STUB_TO_BE_IMPLEMENTED)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/stub comment|placeholder/i)
    })
  })

  describe("does NOT false-positive on real implementations", () => {
    it("accepts real chess move validation code", () => {
      const findings = detectPlaceholderPatterns(REAL_CHESS_MOVE_VALIDATION)
      expect(findings).toHaveLength(0)
    })

    it("accepts real todo-app code", () => {
      const findings = detectPlaceholderPatterns(REAL_TODO_APP)
      expect(findings).toHaveLength(0)
    })

    it("accepts real calculator code", () => {
      const findings = detectPlaceholderPatterns(REAL_CALCULATOR)
      expect(findings).toHaveLength(0)
    })
  })

  describe("line number accuracy", () => {
    it("reports correct line numbers for stubs", () => {
      const code = `line1\nline2\nfunction isValid(x) {\n    return true;\n}\nline6`
      const findings = detectPlaceholderPatterns(code)
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0]).toContain("line 3")
    })

    it("reports function names in findings", () => {
      const code = `function isCheckmate(b, c) {\n    return false;\n}`
      const findings = detectPlaceholderPatterns(code)
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0]).toContain("isCheckmate()")
    })
  })

  describe("caps output length", () => {
    it("returns at most 8 findings", () => {
      // Create a file with many many stubs
      const stubs = Array.from({ length: 20 }, (_, i) =>
        `function isValid${i}(x) { return true; }`
      ).join("\n")
      const findings = detectPlaceholderPatterns(stubs)
      expect(findings.length).toBeLessThanOrEqual(8)
    })
  })
})

describe("code-quality: detectCatchAllReturns", () => {
  it("detects catch-all return true in validation function", () => {
    const code = `
function isMoveLegal(piece, from, to) {
    if (piece === 'pawn') {
        return from[0] === to[0];
    }
    if (piece === 'knight') {
        return Math.abs(from[0]-to[0]) === 2;
    }
    return true;
}
`
    const findings = detectCatchAllReturns(code)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]).toContain("isMoveLegal")
    expect(findings[0]).toContain("catch-all")
  })

  it("does NOT flag exhaustive-loop functions (correct 'return true' after for)", () => {
    const code = `
function isCheckmate(board, color) {
    const pieces = getAllPieces(board, color);
    for (const p of pieces) {
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (isMoveLegal(p, [r, c]) && !wouldBeInCheck(board, p, [r, c])) {
                    return false;
                }
            }
        }
    }
    return true;
}
`
    const findings = detectCatchAllReturns(code)
    expect(findings).toHaveLength(0)
  })

  it("does NOT flag functions with 10+ lines of real logic", () => {
    const code = `
function isValidPosition(board, pos) {
    if (pos[0] < 0 || pos[0] > 7) return false;
    if (pos[1] < 0 || pos[1] > 7) return false;
    const piece = board[pos[0]][pos[1]];
    if (!piece) return false;
    const isWhite = piece === piece.toUpperCase();
    if (currentTurn !== (isWhite ? 'white' : 'black')) return false;
    const neighbors = getNeighbors(pos);
    const threats = countThreats(board, pos);
    if (threats > 3) return false;
    const mobility = calculateMobility(board, pos);
    return true;
}
`
    const findings = detectCatchAllReturns(code)
    expect(findings).toHaveLength(0)
  })

  it("does NOT flag functions without conditional branches", () => {
    const code = `
function isEnabled() {
    const config = getConfig();
    const value = config.enabled;
    return true;
}
`
    const findings = detectCatchAllReturns(code)
    expect(findings).toHaveLength(0)
  })

  it("does NOT flag functions ending with return false", () => {
    const code = `
function canMove(piece, dest) {
    if (piece === 'pawn') return true;
    if (piece === 'rook') return true;
    return false;
}
`
    const findings = detectCatchAllReturns(code)
    expect(findings).toHaveLength(0)
  })

  it("detects catch-all in check/validate/compute family", () => {
    const code = `
function checkCollision(obj1, obj2) {
    if (obj1.type === 'circle') {
        return circleCheck(obj1, obj2);
    }
    return true;
}
`
    const findings = detectCatchAllReturns(code)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]).toContain("checkCollision")
  })
})

describe("code-quality: PLACEHOLDER_PATTERNS", () => {
  it("exports a non-empty array of patterns", () => {
    expect(PLACEHOLDER_PATTERNS.length).toBeGreaterThan(5)
  })

  it("each pattern has a re and label", () => {
    for (const p of PLACEHOLDER_PATTERNS) {
      expect(p.re).toBeInstanceOf(RegExp)
      expect(typeof p.label).toBe("string")
      expect(p.label.length).toBeGreaterThan(0)
    }
  })
})

/**
 * Code quality detection tests — hardcoded cases from real agent traces.
 *
 * Tests PLACEHOLDER_PATTERNS, detectPlaceholderPatterns(), detectCatchAllReturns(),
 * and detectInconsistentBranches() against actual code produced by child agents.
 */
import { describe, expect, it } from "vitest"
import {
    detectCatchAllReturns,
    detectInconsistentBranches,
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

/** LLM degeneration: references "existing" code instead of writing it */
const DEGENERATION_EXISTING_LOGIC = `
function getLegalMoves(row, col, piece, simulateOnly = false) {
  const moves = [];
  const direction = piece === piece.toUpperCase() ? -1 : 1;

  // Other code as per existing logic

  if (!simulateOnly) {
    return moves.filter(move => {
      const tempBoard = JSON.parse(JSON.stringify(board));
      tempBoard[row][col] = null;
      tempBoard[move.row][move.col] = piece;
      return !isInCheck(turn, tempBoard);
    });
  }
  return moves;
}
`

/** LLM degeneration: "rest of the code here" / "remaining logic" */
const DEGENERATION_REST_OF_CODE = `
function renderBoard() {
  const chessboard = document.getElementById('chessboard');
  chessboard.innerHTML = '';
  // rest of the code here
}

function handleInput(event) {
  const value = event.target.value;
  // remaining logic
  return value;
}
`

/** LLM degeneration: "same as above" / "similar to before" */
const DEGENERATION_SAME_AS_ABOVE = `
function processBlack(piece, board) {
  // same as above but for black pieces
  return [];
}

function handleDelete(item) {
  // similar to before
  return true;
}

function updateUI() {
  // code continues as before
}
`

/** LLM degeneration: "as per existing" / "as in the original" */
const DEGENERATION_AS_PER = `
function calculateScore(player) {
  // as per existing implementation
  return 0;
}

function validateMove(from, to) {
  // as in the original code
  return true;
}
`

/** LLM degeneration: ellipsis elision "... remaining" */
const DEGENERATION_ELLIPSIS = `
function buildMenu(items) {
  const menu = document.createElement('ul');
  // ... remaining items
  return menu;
}

function setupRoutes(app) {
  app.get('/', home);
  // ... other routes
}
`

/** REAL code with a "same" variable or "existing" in business logic — should NOT trigger */
const REAL_CODE_WITH_SIMILAR_WORDS = `
function compareVersions(existing, incoming) {
  // Check if existing version is same as incoming
  if (existing.version === incoming.version) return 0;
  return existing.version > incoming.version ? 1 : -1;
}

function updateRecord(record) {
  const existing = database.find(r => r.id === record.id);
  if (!existing) return null;
  return Object.assign(existing, record);
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

/**
 * REAL generated code from agent trace — multi-branch dispatch with inconsistent checks.
 * The isValidMove function checks .color in only 1 of 6 branches.
 * Generic detector catches this without knowing it's a chess game.
 */
const DISPATCH_INCONSISTENT_BRANCHES = `
function isValidMove(fromSquare, toSquare) {
    if (!fromSquare.piece) return false;
    const piece = fromSquare.piece;
    const dx = toSquare.col - fromSquare.col;
    const dy = toSquare.row - fromSquare.row;

    if (piece.symbol === '\\\\u2659' || piece.symbol === '\\\\u265f') {
        const direction = piece.color === 'white' ? -1 : 1;
        if (dx === 0 && dy === direction && !toSquare.piece) return true;
        if (Math.abs(dx) === 1 && dy === direction && toSquare.piece && toSquare.piece.color !== piece.color) return true;
    } else if (piece.symbol === '\\\\u2656' || piece.symbol === '\\\\u265c') {
        if ((dx === 0 || dy === 0) && checkPathClear(fromSquare, toSquare)) return true;
    } else if (piece.symbol === '\\\\u2658' || piece.symbol === '\\\\u265e') {
        if ((Math.abs(dx) === 2 && Math.abs(dy) === 1) || (Math.abs(dx) === 1 && Math.abs(dy) === 2)) return true;
    } else if (piece.symbol === '\\\\u2657' || piece.symbol === '\\\\u265d') {
        if (Math.abs(dx) === Math.abs(dy) && checkPathClear(fromSquare, toSquare)) return true;
    } else if (piece.symbol === '\\\\u2655' || piece.symbol === '\\\\u265b') {
        if ((Math.abs(dx) === Math.abs(dy) || dx === 0 || dy === 0) && checkPathClear(fromSquare, toSquare)) return true;
    } else if (piece.symbol === '\\\\u2654' || piece.symbol === '\\\\u265a') {
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return true;
    }

    return false;
}
`

/** Same function with a global guard before dispatch — should NOT trigger */
const DISPATCH_WITH_GLOBAL_GUARD = `
function isValidMove(fromSquare, toSquare) {
    if (!fromSquare.piece) return false;
    const piece = fromSquare.piece;
    if (toSquare.piece && toSquare.piece.color === piece.color) return false;
    const dx = toSquare.col - fromSquare.col;
    const dy = toSquare.row - fromSquare.row;

    if (piece.symbol === '\\\\u2659' || piece.symbol === '\\\\u265f') {
        const direction = piece.color === 'white' ? -1 : 1;
        if (dx === 0 && dy === direction && !toSquare.piece) return true;
        if (Math.abs(dx) === 1 && dy === direction && toSquare.piece) return true;
    } else if (piece.symbol === '\\\\u2656' || piece.symbol === '\\\\u265c') {
        if ((dx === 0 || dy === 0) && checkPathClear(fromSquare, toSquare)) return true;
    } else if (piece.symbol === '\\\\u2658' || piece.symbol === '\\\\u265e') {
        if ((Math.abs(dx) === 2 && Math.abs(dy) === 1) || (Math.abs(dx) === 1 && Math.abs(dy) === 2)) return true;
    } else if (piece.symbol === '\\\\u2657' || piece.symbol === '\\\\u265d') {
        if (Math.abs(dx) === Math.abs(dy) && checkPathClear(fromSquare, toSquare)) return true;
    } else if (piece.symbol === '\\\\u2655' || piece.symbol === '\\\\u265b') {
        if ((Math.abs(dx) === Math.abs(dy) || dx === 0 || dy === 0) && checkPathClear(fromSquare, toSquare)) return true;
    } else if (piece.symbol === '\\\\u2654' || piece.symbol === '\\\\u265a') {
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return true;
    }

    return false;
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

    it("detects 'Other code as per existing logic' degeneration", () => {
      const findings = detectPlaceholderPatterns(DEGENERATION_EXISTING_LOGIC)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/degeneration/i)
    })

    it("detects 'rest of the code here' / 'remaining logic' degeneration", () => {
      const findings = detectPlaceholderPatterns(DEGENERATION_REST_OF_CODE)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/degeneration/i)
    })

    it("detects 'same as above' / 'similar to before' degeneration", () => {
      const findings = detectPlaceholderPatterns(DEGENERATION_SAME_AS_ABOVE)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/degeneration/i)
    })

    it("detects 'as per existing' / 'as in the original' degeneration", () => {
      const findings = detectPlaceholderPatterns(DEGENERATION_AS_PER)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/degeneration/i)
    })

    it("detects ellipsis elision '... remaining' / '... other'", () => {
      const findings = detectPlaceholderPatterns(DEGENERATION_ELLIPSIS)
      expect(findings.length).toBeGreaterThan(0)
      const joined = findings.join(" ")
      expect(joined).toMatch(/degeneration/i)
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

    it("accepts code using 'existing'/'same' as variable names or in logic (not comments)", () => {
      const findings = detectPlaceholderPatterns(REAL_CODE_WITH_SIMILAR_WORDS)
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

  it("does NOT flag while-loop traversal functions (e.g. isPathClear)", () => {
    // A while-loop path traversal ending in `return true` is NOT a stub —
    // it means the loop checked every square and none was occupied.
    const code = `
function isPathClear(from, to) {
    const rowStep = Math.sign(to.row - from.row);
    const colStep = Math.sign(to.col - from.col);
    let row = from.row + rowStep;
    let col = from.col + colStep;
    while (row !== to.row || col !== to.col) {
        if (board[row][col]) return false;
        row += rowStep;
        col += colStep;
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

// ============================================================================
// Generic structural detector: detectInconsistentBranches
// ============================================================================

describe("code-quality: detectInconsistentBranches", () => {
  it("detects inconsistent .color check in real multi-branch dispatch", () => {
    const findings = detectInconsistentBranches(DISPATCH_INCONSISTENT_BRANCHES)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]).toMatch(/isValidMove/)
    expect(findings[0]).toMatch(/1\/\d/)
    expect(findings[0]).toMatch(/\.color/)
  })

  it("does NOT flag when global guard exists before dispatch chain", () => {
    const findings = detectInconsistentBranches(DISPATCH_WITH_GLOBAL_GUARD)
    expect(findings).toHaveLength(0)
  })

  it("does NOT flag when ALL branches check the same property", () => {
    const code = `
function checkAccess(user, resource) {
    if (resource.type === 'file') {
        if (user.role === resource.role) return true;
    } else if (resource.type === 'folder') {
        if (user.role === resource.role && resource.shared) return true;
    } else if (resource.type === 'link') {
        if (user.role === resource.role) return true;
    }
    return false;
}
`
    const findings = detectInconsistentBranches(code)
    expect(findings).toHaveLength(0)
  })

  it("does NOT flag functions without same-property comparisons", () => {
    const code = `
function route(request) {
    if (request.method === 'GET') {
        return true;
    } else if (request.method === 'POST') {
        return true;
    } else if (request.method === 'PUT') {
        return true;
    }
    return false;
}
`
    const findings = detectInconsistentBranches(code)
    expect(findings).toHaveLength(0)
  })

  it("does NOT flag functions with fewer than 3 branches", () => {
    const code = `
function validate(a, b) {
    if (a.type === 'x') {
        if (a.owner === b.owner) return true;
    } else if (a.type === 'y') {
        return true;
    }
    return false;
}
`
    const findings = detectInconsistentBranches(code)
    expect(findings).toHaveLength(0)
  })

  it("catches auth/permission dispatch with inconsistent .role check", () => {
    const code = `
function checkPermission(user, action, resource) {
    if (action === 'read') {
        if (user.role === resource.role) return true;
    } else if (action === 'write') {
        return true;
    } else if (action === 'delete') {
        return true;
    } else if (action === 'admin') {
        return true;
    }
    return false;
}
`
    const findings = detectInconsistentBranches(code)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]).toMatch(/checkPermission/)
    expect(findings[0]).toMatch(/\.role/)
  })

  it("catches any function name — not limited to validation naming", () => {
    const code = `
function processTransaction(source, target, txType) {
    if (txType === 'transfer') {
        if (source.currency === target.currency) return true;
    } else if (txType === 'swap') {
        return true;
    } else if (txType === 'bridge') {
        return true;
    }
    return false;
}
`
    const findings = detectInconsistentBranches(code)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]).toMatch(/processTransaction/)
    expect(findings[0]).toMatch(/\.currency/)
  })

  it("is integrated into detectPlaceholderPatterns", () => {
    const findings = detectPlaceholderPatterns(DISPATCH_INCONSISTENT_BRANCHES)
    const branchFinding = findings.find(f => /inconsistent branch/i.test(f))
    expect(branchFinding).toBeDefined()
  })
})

// ============================================================================
// Integration: real generated code through the full pipeline
// ============================================================================

describe("code-quality: real generated code detection", () => {
  it("catches branch inconsistency in real broken dispatch code", () => {
    const findings = detectPlaceholderPatterns(DISPATCH_INCONSISTENT_BRANCHES)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const joined = findings.join("\n")
    expect(joined).toMatch(/isValidMove/)
    expect(joined).toMatch(/inconsistent branch/i)
  })

  it("returns ZERO findings for code with global guard", () => {
    const findings = detectPlaceholderPatterns(DISPATCH_WITH_GLOBAL_GUARD)
    expect(findings).toHaveLength(0)
  })

  it("still catches TODO/stub patterns in addition to structural issues", () => {
    const code = `
function processItem(item, target, itemType) {
    // TODO: add logging
    if (itemType === 'typeA') {
        if (item.owner === target.owner) return true;
    } else if (itemType === 'typeB') {
        return true;
    } else if (itemType === 'typeC') {
        return true;
    } else if (itemType === 'typeD') {
        return true;
    }
    return false;
}
`
    const findings = detectPlaceholderPatterns(code)
    expect(findings.length).toBeGreaterThanOrEqual(2)
    const joined = findings.join("\n")
    expect(joined).toMatch(/placeholder comment/i)
    expect(joined).toMatch(/inconsistent branch/i)
  })
})

// ============================================================================
// Regression tests for trace-2026-04-08: chess game stub escape
// ============================================================================
// These reproduce the exact code patterns that escaped detection in the agent
// loop trace from 2026-04-08 (non-functional chess game output).

describe("code-quality: class method stub detection (trace regression)", () => {
  it("detects class method with comment-embedded 'placeholder' keyword", () => {
    // Exact code from the failed chess game trace — the word "placeholder" is
    // buried mid-sentence, not at the start of the comment.
    const code = `class ChessGame {
  constructor() {
    this.board = this.createBoard();
  }

  isLegalMove(start, end) {
    // Basic legal move logic placeholder (to be replaced with full rules)
    return true;
  }
}`
    const findings = detectPlaceholderPatterns(code)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const joined = findings.join("\n")
    expect(joined).toMatch(/placeholder/i)
  })

  it("detects class method stub returning constant (no function keyword)", () => {
    const code = `class Validator {
  isValid(input) {
    return false;
  }
}`
    const findings = detectPlaceholderPatterns(code)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const joined = findings.join("\n")
    expect(joined).toMatch(/stub method|always returns constant/i)
  })

  it("detects class method with comment then trivial return", () => {
    const code = `class Game {
  canMove(piece, target) {
    // Check if the piece can move to the target
    return true;
  }
}`
    const findings = detectPlaceholderPatterns(code)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const joined = findings.join("\n")
    expect(joined).toMatch(/stub method/i)
  })

  it("detects console.log-only function (stub event handler)", () => {
    // Exact pattern from the failed chess game trace
    const code = `function onSquareClick(row, col) {
  // Handle piece selection and moves (placeholder logic for now)
  console.log(\`Square clicked: \${row}, \${col}\`);
}`
    const findings = detectPlaceholderPatterns(code)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const joined = findings.join("\n")
    // Should catch EITHER the placeholder comment OR the console.log-only stub
    expect(joined).toMatch(/placeholder|console\.log-only/i)
  })

  it("detects placeholder keyword mid-sentence in comments", () => {
    // Various real LLM outputs where "placeholder" appears after natural language
    const cases = [
      "// Basic legal move logic placeholder (to be replaced with full rules)",
      "// Handle piece selection and moves (placeholder logic for now)",
      "// This is a placeholder implementation",
      "// Game state placeholder — will be filled in later",
    ]
    for (const comment of cases) {
      const code = `function test() {\n  ${comment}\n  return true;\n}`
      const findings = detectPlaceholderPatterns(code)
      expect(findings.length, `Should detect: ${comment}`).toBeGreaterThanOrEqual(1)
    }
  })

  it("detectCatchAllReturns works on class methods (not just function declarations)", () => {
    const code = `class Game {
  isLegalMove(piece, from, to) {
    if (piece === 'pawn') {
      return to.row === from.row + 1;
    } else if (piece === 'rook') {
      return to.row === from.row || to.col === from.col;
    } else if (piece === 'bishop') {
      return true;
    }
    return true;
  }
}`
    const findings = detectCatchAllReturns(code)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0]).toMatch(/catch-all.*return true.*isLegalMove/i)
  })

  it("does NOT false-positive on if/for/while as method names", () => {
    // The keyword exclusion must prevent matching control flow as methods
    const code = `function process() {
  if (condition) {
    console.log('branching');
  }
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
  while (running) {
    console.log('loop');
  }
}`
    const findings = detectPlaceholderPatterns(code)
    const joined = findings.join("\n")
    // Should NOT report empty method body or console.log-only for if/for/while
    expect(joined).not.toMatch(/empty method body/)
    expect(joined).not.toMatch(/console\.log-only/)
  })

  it("detects empty class method body", () => {
    const code = `class Handler {
  onClick(event) {
  }

  onSubmit(data) {
    // TODO
  }
}`
    const findings = detectPlaceholderPatterns(code)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const joined = findings.join("\n")
    expect(joined).toMatch(/empty method body|placeholder/i)
  })
})

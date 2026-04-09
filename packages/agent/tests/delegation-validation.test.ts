/**
 * Tests for delegation-validation.ts — contract validation of child agent outputs.
 */

import { describe, expect, it } from "vitest"
import {
    buildContractSpec,
    classifyTaskIntent,
    DELEGATION_OUTPUT_VALIDATION_CODES,
    extractAcceptanceTokens,
    getCorrectionGuidance,
    isFileMutationToolCall,
    isLowSignalBrowserToolCall,
    isWorkspaceInspectionToolCall,
    specRequiresBrowserEvidence,
    specRequiresFileMutationEvidence,
    specRequiresSuccessfulToolEvidence,
    specRequiresWorkspaceInspection,
    validateDelegatedOutputContract,
    type DelegationContractSpec,
    type ToolCallRecord
} from "../src/delegation-validation.js"

// ============================================================================
// Helpers
// ============================================================================

function makeSpec(overrides: Partial<DelegationContractSpec> = {}): DelegationContractSpec {
  return {
    task: "Build a chess game with drag-and-drop",
    acceptanceCriteria: ["Board renders 8x8 grid", "Pieces can be dragged"],
    targetArtifacts: ["tmp/chess/game.js", "tmp/chess/index.html"],
    requiredSourceArtifacts: [],
    tools: ["write_file", "read_file", "run_command"],
    effectClass: "filesystem_write",
    verificationMode: "browser_check",
    role: "writer",
    ...overrides,
  }
}

function makeToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    name: "write_file",
    args: { path: "tmp/chess/game.js", content: "console.log('hello')" },
    result: "Successfully wrote to tmp/chess/game.js",
    isError: false,
    ...overrides,
  }
}

// ============================================================================
// validateDelegatedOutputContract
// ============================================================================

describe("validateDelegatedOutputContract", () => {
  describe("empty output detection", () => {
    it("detects empty string output", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "",
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("empty_output")
    })

    it("detects whitespace-only output", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "   \n  \t  ",
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("empty_output")
    })

    it("detects null/undefined/{}/ empty values", () => {
      for (const val of ["null", "undefined", "{}", "[]"]) {
        const result = validateDelegatedOutputContract({
          spec: makeSpec(),
          output: val,
        })
        expect(result.ok).toBe(false)
        expect(result.code).toBe("empty_structured_payload")
      }
    })
  })

  describe("blocked phase detection", () => {
    it("detects blocked output without completion claim", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "I am blocked on external dependencies. Cannot proceed with this task. Blocked on API access.",
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("blocked_phase_output")
    })

    it("allows output mentioning blocked but also completion", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "I was initially blocked but found a workaround and completed the task. Created all files successfully. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      // Should not be flagged as blocked since it also claims completion
      expect(result.code).not.toBe("blocked_phase_output")
    })
  })

  describe("unresolved handoff detection", () => {
    it("rejects outputs that ask user whether to continue implementation", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "The game currently meets foundational requirements. Further refinements can be made. Would you like to proceed with implementing missing game mechanics? tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("unresolved_handoff_output")
    })

    it("does not apply handoff rule to pure research tasks", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({
          task: "Review architecture and identify risks",
          acceptanceCriteria: [],
          role: "reviewer",
          effectClass: "readonly",
          targetArtifacts: [],
          requiredSourceArtifacts: ["src/engine.ts"],
        }),
        output: "I reviewed the current architecture. Would you like me to continue with a deeper analysis? src/engine.ts",
        toolCalls: [
          makeToolCall({ name: "read_file", args: { path: "src/engine.ts" }, result: "code..." }),
        ],
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("tool evidence checks", () => {
    it("detects all-failed tool calls", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "I tried to create the files but encountered errors. tmp/chess/game.js",
        toolCalls: [
          makeToolCall({ isError: true, result: "Error: ENOENT" }),
          makeToolCall({ name: "read_file", isError: true, result: "Error: not found" }),
        ],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("all_tools_failed")
    })

    it("detects narrative claims without tool calls", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "I created the chess game with drag-and-drop support.",
        toolCalls: [],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("missing_successful_tool_evidence")
    })

    it("passes when tool calls are successful", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "Created tmp/chess/game.js with full chess implementation including board rendering and drag-and-drop pieces.",
        toolCalls: [
          makeToolCall(),
          makeToolCall({ name: "read_file", args: { path: "tmp/chess/game.js" }, result: "game code..." }),
        ],
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("file mutation evidence", () => {
    it("detects missing file mutation when contract requires it", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "I reviewed the requirements and planned the implementation. Board renders 8x8 grid. tmp/chess/game.js",
        toolCalls: [
          makeToolCall({ name: "read_file", args: { path: "README.md" }, result: "readme content" }),
        ],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("missing_file_mutation_evidence")
    })

    it("accepts shell-based file creation", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "Created files via shell commands. Board renders 8x8 grid. Pieces can be dragged. tmp/chess/game.js",
        toolCalls: [
          makeToolCall({
            name: "run_command",
            args: { command: "cat > tmp/chess/game.js << 'EOF'\nconsole.log('chess')\nEOF" },
            result: "",
          }),
        ],
      })
      expect(result.ok).toBe(true)
    })

    it("skips file mutation check for readonly contracts", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ effectClass: "readonly", targetArtifacts: [] }),
        output: "Reviewed the codebase. Board renders 8x8 grid. Everything looks good.",
        toolCalls: [
          makeToolCall({ name: "read_file", args: { path: "src/app.ts" }, result: "code..." }),
        ],
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("workspace inspection evidence", () => {
    it("detects missing workspace inspection for reviewer role", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({
          role: "reviewer",
          effectClass: "readonly",
          targetArtifacts: [],
          requiredSourceArtifacts: ["src/game.js"],
        }),
        output: "The code looks good. Board renders 8x8. Pieces dragged. src/game.js",
        toolCalls: [
          makeToolCall({ name: "run_command", args: { command: "echo hello" }, result: "hello" }),
        ],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("missing_workspace_inspection_evidence")
    })
  })

  describe("required source artifact evidence", () => {
    it("detects missing source file reads", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({
          requiredSourceArtifacts: ["src/engine.ts", "src/board.ts"],
        }),
        output: "Created the chess game. Board renders 8x8 grid. Pieces dragged. tmp/chess/game.js",
        toolCalls: [
          makeToolCall(), // write_file only, no reads
        ],
      })
      expect(result.ok).toBe(false)
      // workspace inspection fires before required source evidence (priority ordering)
      expect(result.code).toBe("missing_workspace_inspection_evidence")
    })

    it("passes when source files are read (basename match)", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({
          requiredSourceArtifacts: ["src/engine.ts"],
        }),
        output: "Read source, created chess game. Board renders 8x8 grid. Pieces dragged. tmp/chess/game.js",
        toolCalls: [
          makeToolCall({ name: "read_file", args: { path: "/project/src/engine.ts" }, result: "code..." }),
          makeToolCall(),
        ],
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("file artifact evidence in output", () => {
    it("detects missing file paths in output after mutation", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "I created all the chess game files successfully with board rendering and drag-and-drop",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("missing_file_artifact_evidence")
    })
  })

  describe("browser evidence quality", () => {
    it("detects low-signal browser evidence", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ verificationMode: "browser_check" }),
        output: "Tested in browser. Board renders 8x8 grid. Pieces dragged. tmp/chess/game.js",
        toolCalls: [
          makeToolCall(),
          makeToolCall({
            name: "browser_tab_list",
            args: {},
            result: "[about:blank]",
          }),
        ],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("low_signal_browser_evidence")
    })

    it("passes with meaningful browser evidence", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ verificationMode: "browser_check" }),
        output: "Created and tested chess game. Board renders 8x8 grid. Pieces can be dragged. tmp/chess/game.js",
        toolCalls: [
          makeToolCall(),
          makeToolCall({
            name: "browser_check",
            args: { path: "tmp/chess/index.html" },
            result: "Page loaded, no JS errors",
          }),
        ],
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("contradictory completion claim", () => {
    it("detects TODO markers in completed output", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "Done! Created all files. TODO: implement drag-and-drop. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("contradictory_completion_claim")
    })

    it("detects FIXME markers in completed output", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "Successfully implemented the chess game. FIXME: board rendering is broken. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("contradictory_completion_claim")
    })

    it("detects PLACEHOLDER markers", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "Completed the implementation. Note: PLACEHOLDER logic in move validation. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("contradictory_completion_claim")
    })

    it("does NOT false-positive on 'later' in normal English descriptions", () => {
      // Real trace: child said "appends it to the highlightedSquares array for later clearing"
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ acceptanceCriteria: [] }),
        output: "Successfully implemented UI. highlightSquare appends it to the highlightedSquares array for later clearing. tmp/chess/ui.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(true)
    })

    it("does NOT false-positive on 'incomplete' in review context", () => {
      // Real trace: child said "checking for incomplete implementations"
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ acceptanceCriteria: [] }),
        output: "Done! Verified all code by checking for incomplete patterns — found none. All functions have real logic. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(true)
    })

    it("does NOT false-positive on 'will be' in descriptive context", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ acceptanceCriteria: [] }),
        output: "Completed implementation. The status display will be updated whenever a move is made. tmp/chess/status.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(true)
    })

    it("does NOT false-positive on 'comes back' in code description", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ acceptanceCriteria: [] }),
        output: "Done! The function comes back to the caller with the validated result. tmp/chess/validate.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(true)
    })

    it("DOES detect 'implement later' as unresolved work", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ acceptanceCriteria: [] }),
        output: "Created the game files. Will implement later the castling logic. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("contradictory_completion_claim")
    })

    it("DOES detect 'implementation is incomplete' as unresolved work", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ acceptanceCriteria: [] }),
        output: "Created game.js. The implementation is incomplete for pawn promotion. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("contradictory_completion_claim")
    })

    it("DOES detect 'will be implemented' as unresolved work", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({ acceptanceCriteria: [] }),
        output: "Done with basic structure. En passant will be implemented in a follow-up. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("contradictory_completion_claim")
    })
  })

  describe("acceptance evidence", () => {
    it("detects missing acceptance criteria tokens", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec({
          acceptanceCriteria: [
            "Chess board renders 8x8 grid with alternating colors",
            "Pieces display correct Unicode symbols",
            "Drag-and-drop moves pieces between squares",
            "Move validation enforces legal chess moves",
            "Check and checkmate detection works correctly",
          ],
        }),
        output: "Created a hello world application. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe("acceptance_evidence_missing")
    })

    it("passes when acceptance tokens are present", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "Created chess game with board that renders an 8x8 grid. Pieces can be dragged between squares. tmp/chess/game.js",
        toolCalls: [makeToolCall()],
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("full pass scenario", () => {
    it("passes when all evidence is present", () => {
      const result = validateDelegatedOutputContract({
        spec: makeSpec(),
        output: "Created tmp/chess/game.js and tmp/chess/index.html. Board renders 8x8 grid with alternating colors. Pieces can be dragged between squares.",
        toolCalls: [
          makeToolCall({ name: "read_file", args: { path: "README.md" }, result: "project readme" }),
          makeToolCall({ name: "write_file", args: { path: "tmp/chess/game.js" }, result: "Success" }),
          makeToolCall({ name: "write_file", args: { path: "tmp/chess/index.html" }, result: "Success" }),
          makeToolCall({ name: "browser_check", args: { path: "tmp/chess/index.html" }, result: "No JS errors" }),
        ],
      })
      expect(result.ok).toBe(true)
    })
  })
})

// ============================================================================
// classifyTaskIntent
// ============================================================================

describe("classifyTaskIntent", () => {
  it("classifies implementation tasks", () => {
    expect(classifyTaskIntent(makeSpec({ task: "Build a chess game" }))).toBe("implementation")
  })

  it("classifies research tasks", () => {
    expect(classifyTaskIntent(makeSpec({
      task: "Research the best approach for chess AI",
      role: "reviewer",
      effectClass: "readonly",
      targetArtifacts: [],
    }))).toBe("research")
  })

  it("classifies validation tasks", () => {
    expect(classifyTaskIntent(makeSpec({
      task: "Test the chess game and verify all moves",
      role: "validator",
      effectClass: "readonly",
      targetArtifacts: [],
    }))).toBe("validation")
  })

  it("classifies mixed tasks", () => {
    expect(classifyTaskIntent(makeSpec({
      task: "Investigate and implement the fix",
      role: "writer",
      effectClass: "readonly",
      targetArtifacts: [],
    }))).toBe("mixed")
  })
})

// ============================================================================
// extractAcceptanceTokens
// ============================================================================

describe("extractAcceptanceTokens", () => {
  it("extracts tokens >= 4 chars", () => {
    const tokens = extractAcceptanceTokens(["Board renders 8x8 grid"])
    expect(tokens).toContain("board")
    expect(tokens).toContain("renders")
    expect(tokens).toContain("grid")
    // "8x8" is only 3 chars — excluded
    expect(tokens).not.toContain("8x8")
  })

  it("deduplicates tokens", () => {
    const tokens = extractAcceptanceTokens(["board renders", "board displays"])
    const boardCount = tokens.filter(t => t === "board").length
    expect(boardCount).toBe(1)
  })

  it("handles empty criteria", () => {
    expect(extractAcceptanceTokens([])).toEqual([])
  })
})

// ============================================================================
// Tool call classification
// ============================================================================

describe("isFileMutationToolCall", () => {
  it("identifies write_file as mutation", () => {
    expect(isFileMutationToolCall(makeToolCall({ name: "write_file" }))).toBe(true)
  })

  it("identifies shell file writes", () => {
    expect(isFileMutationToolCall(makeToolCall({
      name: "run_command",
      args: { command: "cat > output.js << EOF\nconsole.log('hi')\nEOF" },
    }))).toBe(true)
  })

  it("identifies npm create as scaffold", () => {
    expect(isFileMutationToolCall(makeToolCall({
      name: "run_command",
      args: { command: "npm create vite@latest my-app" },
    }))).toBe(true)
  })

  it("does not identify read_file as mutation", () => {
    expect(isFileMutationToolCall(makeToolCall({ name: "read_file" }))).toBe(false)
  })
})

describe("isWorkspaceInspectionToolCall", () => {
  it("identifies read_file as inspection", () => {
    expect(isWorkspaceInspectionToolCall(makeToolCall({ name: "read_file" }))).toBe(true)
  })

  it("identifies list_directory as inspection", () => {
    expect(isWorkspaceInspectionToolCall(makeToolCall({ name: "list_directory" }))).toBe(true)
  })

  it("does not identify write_file as inspection", () => {
    expect(isWorkspaceInspectionToolCall(makeToolCall({ name: "write_file" }))).toBe(false)
  })
})

describe("isLowSignalBrowserToolCall", () => {
  it("identifies browser_tab_list as low signal", () => {
    expect(isLowSignalBrowserToolCall(makeToolCall({
      name: "browser_tab_list",
      args: {},
    }))).toBe(true)
  })

  it("identifies about:blank navigation as low signal", () => {
    expect(isLowSignalBrowserToolCall(makeToolCall({
      name: "browser_check",
      args: { url: "about:blank" },
    }))).toBe(true)
  })

  it("does not flag real browser check", () => {
    expect(isLowSignalBrowserToolCall(makeToolCall({
      name: "browser_check",
      args: { path: "tmp/index.html" },
    }))).toBe(false)
  })
})

// ============================================================================
// Spec requirements classification
// ============================================================================

describe("specRequiresFileMutationEvidence", () => {
  it("requires mutation for writer with target artifacts", () => {
    expect(specRequiresFileMutationEvidence(makeSpec())).toBe(true)
  })

  it("does not require mutation for readonly", () => {
    expect(specRequiresFileMutationEvidence(makeSpec({ effectClass: "readonly" }))).toBe(false)
  })
})

describe("specRequiresSuccessfulToolEvidence", () => {
  it("requires tools when artifacts and criteria exist", () => {
    expect(specRequiresSuccessfulToolEvidence(makeSpec())).toBe(true)
  })

  it("does not require tools when no tools available", () => {
    expect(specRequiresSuccessfulToolEvidence(makeSpec({ tools: [] }))).toBe(false)
  })
})

describe("specRequiresWorkspaceInspection", () => {
  it("requires inspection for reviewer role", () => {
    expect(specRequiresWorkspaceInspection(makeSpec({ role: "reviewer" }))).toBe(true)
  })

  it("requires inspection when source artifacts listed", () => {
    expect(specRequiresWorkspaceInspection(makeSpec({
      requiredSourceArtifacts: ["src/game.ts"],
    }))).toBe(true)
  })

  it("does not require inspection for plain writer", () => {
    expect(specRequiresWorkspaceInspection(makeSpec())).toBe(false)
  })
})

describe("specRequiresBrowserEvidence", () => {
  it("requires browser for browser_check mode", () => {
    expect(specRequiresBrowserEvidence(makeSpec({ verificationMode: "browser_check" }))).toBe(true)
  })

  it("does not require browser for test mode", () => {
    expect(specRequiresBrowserEvidence(makeSpec({ verificationMode: "test" }))).toBe(false)
  })
})

// ============================================================================
// Correction guidance
// ============================================================================

describe("getCorrectionGuidance", () => {
  it("returns guidance for every validation code", () => {
    for (const code of DELEGATION_OUTPUT_VALIDATION_CODES) {
      const guidance = getCorrectionGuidance(code)
      expect(guidance).toBeTruthy()
      expect(typeof guidance).toBe("string")
      expect(guidance.length).toBeGreaterThan(10)
    }
  })
})

// ============================================================================
// buildContractSpec
// ============================================================================

describe("buildContractSpec", () => {
  it("builds spec from step + envelope", () => {
    const spec = buildContractSpec(
      {
        objective: "Build chess game",
        acceptanceCriteria: ["Board renders"],
        requiredToolCapabilities: ["browser_check"],
      },
      {
        targetArtifacts: ["game.js"],
        requiredSourceArtifacts: ["src/engine.ts"],
        allowedTools: ["write_file"],
        effectClass: "filesystem_write",
        verificationMode: "browser_check",
        role: "writer",
      },
    )

    expect(spec.task).toBe("Build chess game")
    expect(spec.acceptanceCriteria).toEqual(["Board renders"])
    expect(spec.targetArtifacts).toEqual(["game.js"])
    expect(spec.requiredSourceArtifacts).toEqual(["src/engine.ts"])
    expect(spec.tools).toContain("write_file")
    expect(spec.tools).toContain("browser_check")
    expect(spec.effectClass).toBe("filesystem_write")
    expect(spec.role).toBe("writer")
  })

  it("carries lastValidationCode when provided", () => {
    const spec = buildContractSpec(
      { objective: "Fix issues", acceptanceCriteria: [], requiredToolCapabilities: [] },
      { targetArtifacts: [], requiredSourceArtifacts: [], allowedTools: [], effectClass: "readonly", verificationMode: "none" },
      "contradictory_completion_claim",
    )
    expect(spec.lastValidationCode).toBe("contradictory_completion_claim")
  })
})

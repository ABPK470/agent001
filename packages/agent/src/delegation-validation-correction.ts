/**
 * Delegation validation correction routing — maps validation failure codes
 * to targeted retry guidance for child agents.
 *
 * Extracted from delegation-validation.ts.
 *
 * @module
 */

import type { DelegationOutputValidationCode } from "./delegation-validation.js"

/**
 * Get targeted retry guidance for a specific validation failure.
 * This is injected into the child's retry context so it knows exactly
 * what class of fix is needed.
 */
export function getCorrectionGuidance(code: DelegationOutputValidationCode): string {
  switch (code) {
    case "empty_output":
      return "Your previous attempt produced no output. You MUST use tools to accomplish the task and provide a summary of what you did."

    case "empty_structured_payload":
      return "Your previous attempt returned an empty value. You must produce real, substantive output."

    case "acceptance_evidence_missing":
      return "Your previous output didn't mention key acceptance criteria. Re-read the acceptance criteria and ensure your output addresses each one with concrete evidence (file paths, test results, implementation details)."

    case "contradictory_completion_claim":
      return "Your previous output claimed completion but contained TODO/FIXME/PLACEHOLDER markers. You MUST resolve ALL unfinished work before claiming completion. Search your code for TODO, FIXME, PLACEHOLDER, and stub patterns."

    case "missing_file_mutation_evidence":
      return "Your previous attempt didn't create/modify the required files. Use write_file to create the target artifacts. Do NOT just describe what should be done — actually create the files."

    case "missing_successful_tool_evidence":
      return "Your previous attempt claimed to have done work but made no successful tool calls. You MUST use tools (write_file, read_file, run_command) to accomplish the task."

    case "blocked_phase_output":
      return "Your previous attempt reported being blocked or unable to proceed. Try a different approach. If you can't access a resource, work around it. Do NOT report blockage — find a solution."

    case "missing_file_artifact_evidence":
      return "Your previous attempt used file tools but didn't provide clear file-path evidence. Include modified file paths in your output summary and ensure file-tool calls include explicit path arguments."

    case "missing_workspace_inspection_evidence":
      return "Your previous attempt didn't read the required source files. Use read_file to read ALL source files listed in your goal BEFORE making changes."

    case "missing_required_source_evidence":
      return "Your previous attempt skipped reading required source files. You MUST read every file listed in the Source Files section before modifying anything."

    case "all_tools_failed":
      return "All your tool calls failed in the previous attempt. Check your tool arguments (file paths, command syntax) and try again with correct arguments."

    case "low_signal_browser_evidence":
      return "Your browser testing was insufficient — you only checked about:blank or listed tabs. Use browser_check with an actual file path to verify your HTML/JS works."

    case "missing_executable_verification_evidence":
      return "Your previous attempt relied on narrative completion without executable proof. Run deterministic verification (tests/build/runtime checks) or inspect mutated artifacts with read_file before claiming completion."

    case "unresolved_handoff_output":
      return "Your previous output ended in a handoff/partial state. Do NOT ask whether to continue. Complete the implementation end-to-end, verify behavior, and return finished artifacts with evidence."

    case "missing_target_artifact_coverage":
      return "Your previous attempt modified files, but not the declared target artifacts. You MUST create or update the exact target artifacts in your contract and report them in your summary."

    case "unresolved_artifact_references":
      return "Your previous output wrote code that references local files/assets without evidence they exist. Create those referenced artifacts (or update references) before claiming completion."
  }
}

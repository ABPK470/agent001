/**
 * Delegation validation correction routing — maps validation failure codes
 * to targeted retry guidance for child agents.
 *
 * Extracted from delegation-validation.ts.
 *
 * @module
 */

import { DelegationOutputValidationCode } from "../../domain/enums/delegation.js"

/**
 * Get targeted retry guidance for a specific validation failure.
 * This is injected into the child's retry context so it knows exactly
 * what class of fix is needed.
 */
export function getCorrectionGuidance(code: DelegationOutputValidationCode): string {
  switch (code) {
    case DelegationOutputValidationCode.EmptyOutput:
      return "Your previous attempt produced no output. You MUST use tools to accomplish the task and provide a summary of what you did."

    case DelegationOutputValidationCode.EmptyStructuredPayload:
      return "Your previous attempt returned an empty value. You must produce real, substantive output."

    case DelegationOutputValidationCode.AcceptanceEvidenceMissing:
      return "Your previous output didn't mention key acceptance criteria. Re-read the acceptance criteria and ensure your output addresses each one with concrete evidence (file paths, test results, implementation details)."

    case DelegationOutputValidationCode.ContradictoryCompletionClaim:
      return "Your previous output claimed completion but contained TODO/FIXME/PLACEHOLDER markers. You MUST resolve ALL unfinished work before claiming completion. Search your code for TODO, FIXME, PLACEHOLDER, and stub patterns."

    case DelegationOutputValidationCode.MissingFileMutationEvidence:
      return "Your previous attempt didn't create/modify the required files. Use write_file to create the target artifacts. Do NOT just describe what should be done — actually create the files."

    case DelegationOutputValidationCode.MissingSuccessfulToolEvidence:
      return "Your previous attempt claimed to have done work but made no successful tool calls. You MUST use tools (write_file, read_file, run_command) to accomplish the task."

    case DelegationOutputValidationCode.BlockedPhaseOutput:
      return "Your previous attempt reported being blocked or unable to proceed. Try a different approach. If you can't access a resource, work around it. Do NOT report blockage — find a solution."

    case DelegationOutputValidationCode.MissingFileArtifactEvidence:
      return "Your previous attempt used file tools but didn't provide clear file-path evidence. Include modified file paths in your output summary and ensure file-tool calls include explicit path arguments."

    case DelegationOutputValidationCode.MissingWorkspaceInspectionEvidence:
      return "Your previous attempt didn't read the required source files. Use read_file to read ALL source files listed in your goal BEFORE making changes."

    case DelegationOutputValidationCode.MissingRequiredSourceEvidence:
      return "Your previous attempt skipped reading required source files. You MUST read every file listed in the Source Files section before modifying anything."

    case DelegationOutputValidationCode.AllToolsFailed:
      return "All your tool calls failed in the previous attempt. Check your tool arguments (file paths, command syntax) and try again with correct arguments."

    case DelegationOutputValidationCode.MissingExecutableVerificationEvidence:
      return "Your previous attempt relied on narrative completion without executable proof. Run deterministic verification (tests/build/runtime checks) or inspect mutated artifacts with read_file before claiming completion."

    case DelegationOutputValidationCode.LowSignalBrowserEvidence:
      return "Your verification was insufficient — run read_file on the artifacts or run_command with tests/build before claiming completion."

    case DelegationOutputValidationCode.UnresolvedHandoffOutput:
      return "Your previous output ended in a handoff/partial state. Do NOT ask whether to continue. Complete the implementation end-to-end, verify behavior, and return finished artifacts with evidence."

    case DelegationOutputValidationCode.MissingTargetArtifactCoverage:
      return "Your previous attempt modified files, but not the declared target artifacts. You MUST create or update the exact target artifacts in your contract and report them in your summary."

    case DelegationOutputValidationCode.UnresolvedArtifactReferences:
      return "Your previous output wrote code that references local files/assets without evidence they exist. Create those referenced artifacts (or update references) before claiming completion."
  }
}

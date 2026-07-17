/**
 * Finish.
 *
 * Input: the final answer string.
 * Output: the same string (after optional verbose logging).
 * Next: none — the run is complete.
 */

import * as log from "../../../internal/index.js"

export function finish(answer: string, verbose: boolean): string {
  if (verbose) log.logFinalAnswer(answer)
  return answer
}

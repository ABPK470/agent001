/**
 * Prepare one loop iteration.
 *
 * Input: messages, tools, iteration index, loop state.
 * Output: compacted messages + the tool list the model may see this turn.
 * Next: askTheModel.
 */

export { prepareIterationContext as prepareIteration } from "../iteration-prepare.js"

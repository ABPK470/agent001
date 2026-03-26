/**
 * Think tool — structured reasoning step.
 *
 * This might seem pointless ("why would a tool just return its input?")
 * but it's actually important:
 *
 * 1. It gives the agent a place to reason about what it observed
 * 2. The thought gets recorded in message history (context for next steps)
 * 3. It separates reasoning from action — you can see the agent's logic
 *
 * Many production agents use this pattern (including Anthropic's recommendations).
 */

import type { Tool } from "../types.js"

export const thinkTool: Tool = {
  name: "think",
  description:
    "Use this tool to think through a problem step by step. " +
    "Record your reasoning, plan next steps, or analyze observations. " +
    "The thought is recorded in your context for future reference.",
  parameters: {
    type: "object",
    properties: {
      thought: {
        type: "string",
        description: "Your reasoning or analysis",
      },
    },
    required: ["thought"],
  },

  async execute(args) {
    return String(args.thought)
  },
}
